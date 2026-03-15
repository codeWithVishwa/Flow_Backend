import { Server } from "socket.io";
import User from "./models/user.model.js";
import Conversation from "./models/conversation.model.js";
import Message from "./models/message.model.js";
import { sendPushNotification } from "./utils/expoPush.js";
import { deliverPendingNotificationsOnReconnect } from "./utils/messageNotifications.js";

let io;
// Presence set (kept for existing features like presence:update)
const onlineUsers = new Set();
const pendingOfflineTimers = new Map();
const PRESENCE_OFFLINE_GRACE_MS = 12000;

// Active audio call tracking (in-memory)
const activeCalls = new Map(); // callId -> { callerId, calleeId, createdAt }
const userActiveCall = new Map(); // userId -> callId

// Requirement: maintain in-memory map userId -> socketId
// Note: users may connect from multiple devices; we store a Set of socketIds.
const userSocketIds = new Map();

function clearPendingOffline(userId) {
  const uid = String(userId || "");
  if (!uid) return;
  const timer = pendingOfflineTimers.get(uid);
  if (!timer) return;
  clearTimeout(timer);
  pendingOfflineTimers.delete(uid);
}

export function emitMessageDeliveredReceipt({ conversationId, messageIds = [], recipientId, senderId }) {
  if (!io || !conversationId || !recipientId || !senderId) return;
  const normalizedMessageIds = (Array.isArray(messageIds) ? messageIds : [])
    .map((id) => String(id || ""))
    .filter(Boolean);
  if (!normalizedMessageIds.length) return;
  io.to(`user:${String(senderId)}`).emit("message:delivered", {
    conversationId: String(conversationId),
    recipientId: String(recipientId),
    messageIds: normalizedMessageIds,
  });
}

export function initSocket(server) {
  const configuredOrigins = [
    process.env.FRONTEND_URL,
    process.env.APP_BASE_URL,
    "http://localhost:19006",
    "http://127.0.0.1:19006",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ].filter(Boolean);

  const normalizeOrigin = (value) => {
    if (!value || typeof value !== "string") return null;
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  };
  const allowedOrigins = new Set(configuredOrigins.map(normalizeOrigin).filter(Boolean));

  io = new Server(server, {
    cors: {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (process.env.NODE_ENV !== "production") return cb(null, true);
        if (/^https?:\/\/localhost(?::\d+)?$/i.test(origin) || /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin)) {
          return cb(null, true);
        }
        const normalized = normalizeOrigin(origin);
        if (normalized && allowedOrigins.has(normalized)) return cb(null, true);
        return cb(new Error("Not allowed by CORS"));
      },
      credentials: true,
    },
  });

  const registerCall = (callId, callerId, calleeId) => {
    const entry = { callId, callerId: String(callerId), calleeId: String(calleeId), createdAt: Date.now() };
    activeCalls.set(String(callId), entry);
    userActiveCall.set(String(callerId), String(callId));
    userActiveCall.set(String(calleeId), String(callId));
    return entry;
  };

  const clearCall = (callId) => {
    const entry = activeCalls.get(String(callId));
    if (!entry) return null;
    userActiveCall.delete(String(entry.callerId));
    userActiveCall.delete(String(entry.calleeId));
    activeCalls.delete(String(callId));
    return entry;
  };

  const getOtherParty = (entry, userId) => {
    const uid = String(userId);
    if (String(entry.callerId) === uid) return entry.calleeId;
    if (String(entry.calleeId) === uid) return entry.callerId;
    return null;
  };

  const emitTypingEvent = async ({ conversationId, userId, eventName }) => {
    if (!conversationId || !userId || !eventName) return;
    const convo = await Conversation.findById(conversationId).select("participants");
    if (!convo?.participants?.length) return;
    const senderId = String(userId);
    const isParticipant = convo.participants.some((id) => String(id) === senderId);
    if (!isParticipant) return;
    convo.participants
      .map((id) => String(id))
      .filter((id) => id !== senderId)
      .forEach((id) => {
        io.to(`user:${id}`).emit(eventName, { conversationId, userId: senderId });
      });
  };

  const flushDeliveredMessagesForUser = async (userId) => {
    const uid = String(userId || "");
    if (!uid) return;
    const conversations = await Conversation.find({ participants: uid }).select("_id");
    if (!conversations.length) return;
    const conversationIds = conversations.map((entry) => entry._id);
    const pendingMessages = await Message.find({
      conversation: { $in: conversationIds },
      sender: { $ne: uid },
      deliveredTo: { $ne: uid },
    })
      .select("_id conversation sender")
      .sort({ createdAt: 1 })
      .limit(500)
      .lean();
    if (!pendingMessages.length) return;

    const pendingIds = pendingMessages.map((entry) => entry._id);
    await Message.updateMany(
      { _id: { $in: pendingIds } },
      { $addToSet: { deliveredTo: uid } }
    );

    const grouped = new Map();
    pendingMessages.forEach((entry) => {
      const key = `${String(entry.conversation)}:${String(entry.sender)}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          conversationId: String(entry.conversation),
          senderId: String(entry.sender),
          messageIds: [],
        });
      }
      grouped.get(key).messageIds.push(String(entry._id));
    });

    grouped.forEach((entry) => {
      emitMessageDeliveredReceipt({
        conversationId: entry.conversationId,
        messageIds: entry.messageIds,
        recipientId: uid,
        senderId: entry.senderId,
      });
    });
  };

  const scheduleOfflinePresence = (userId) => {
    const uid = String(userId || "");
    if (!uid) return;
    clearPendingOffline(uid);
    pendingOfflineTimers.set(
      uid,
      setTimeout(async () => {
        pendingOfflineTimers.delete(uid);
        if (getSocketIdsForUser(uid).length > 0) return;
        if (!onlineUsers.has(uid)) return;
        onlineUsers.delete(uid);
        const ts = new Date();
        await User.findByIdAndUpdate(uid, { lastActiveAt: ts }).catch(() => {});
        io.emit("presence:update", {
          userId: uid,
          online: false,
          lastActiveAt: ts.toISOString(),
        });
      }, PRESENCE_OFFLINE_GRACE_MS)
    );
  };

  io.on("connection", async (socket) => {
    const userId = socket.handshake.auth?.userId || socket.handshake.query?.userId;
    const socketUserId = userId ? String(userId) : null;
    if (userId) {
      // 1) Track socket mapping for real-time notifications
      const uid = String(userId);
      const wasOnline = onlineUsers.has(uid);
      clearPendingOffline(uid);
      if (!userSocketIds.has(uid)) userSocketIds.set(uid, new Set());
      userSocketIds.get(uid).add(socket.id);

      socket.join(`user:${userId}`);
      onlineUsers.add(uid);

      socket.emit("presence:snapshot", { userIds: Array.from(onlineUsers) });
      
      const connectedAt = new Date();
      User.findByIdAndUpdate(userId, { lastActiveAt: connectedAt }).catch(()=>{});
      if (!wasOnline) {
        io.emit("presence:update", { userId: String(userId), online: true, lastActiveAt: connectedAt.toISOString() });
      }

      try {
        await flushDeliveredMessagesForUser(uid);
      } catch (e) {
        console.error("Error flushing delivered messages", e);
      }

      // 2) Deliver any queued (offline) message notifications on reconnect
      try {
        await deliverPendingNotificationsOnReconnect({ io, userId: uid, socketId: socket.id });
      } catch (e) {
        console.error("Error delivering pending notifications", e);
      }

      // Check for offline notifications
      try {
        const user = await User.findById(userId).select("pushToken offlineNotifications");
        if (user && user.offlineNotifications && user.offlineNotifications.length > 0) {
          // Send summary push
          if (user.pushToken) {
            const count = user.offlineNotifications.reduce((acc, n) => acc + n.count, 0);
            const senders = user.offlineNotifications.length;
            const title = `You have ${count} new messages`;
            const body = `From ${senders} chats while you were away.`;
            
            // Optional: Send summary push
            // await sendPushNotification(user.pushToken, title, body, { type: 'summary' });
          }
          
          // Clear queue
          user.offlineNotifications = [];
          await user.save();
        }
      } catch (e) {
        console.error("Error processing offline notifications", e);
      }
    }

    socket.on("typing:start", async (payload = {}) => {
      try {
        if (!socketUserId) return;
        const conversationId = payload?.conversationId;
        if (!conversationId) return;
        const now = Date.now();
        const lastStartAt = socket.data?.typingStartAt || 0;
        if (now - lastStartAt < 700) return;
        socket.data.typingStartAt = now;
        const previousConversationId = socket.data?.typingConversationId;
        if (
          previousConversationId &&
          String(previousConversationId) !== String(conversationId)
        ) {
          await emitTypingEvent({
            conversationId: previousConversationId,
            userId: socketUserId,
            eventName: "typing:stop",
          });
        }
        socket.data.typingConversationId = String(conversationId);
        await emitTypingEvent({
          conversationId,
          userId: socketUserId,
          eventName: "typing:start",
        });
      } catch {}
    });

    socket.on("typing:stop", async (payload = {}) => {
      try {
        if (!socketUserId) return;
        const conversationId = payload?.conversationId;
        if (!conversationId) return;
        const now = Date.now();
        const lastStopAt = socket.data?.typingStopAt || 0;
        if (now - lastStopAt < 300) return;
        socket.data.typingStopAt = now;
        if (String(socket.data?.typingConversationId || "") === String(conversationId)) {
          socket.data.typingConversationId = null;
        }
        await emitTypingEvent({
          conversationId,
          userId: socketUserId,
          eventName: "typing:stop",
        });
      } catch {}
    });

    socket.on("call:invite", (payload) => {
      const callId = payload?.callId;
      const fromUserId = payload?.fromUserId;
      const toUserId = payload?.toUserId;
      if (!callId || !fromUserId || !toUserId) return;

      const fromId = String(fromUserId);
      const toId = String(toUserId);
      if (socketUserId && String(socketUserId) !== fromId) return;
      if (fromId === toId) return;
      const existingForCallee = userActiveCall.get(toId);
      const existingForCaller = userActiveCall.get(fromId);
      if (existingForCallee || existingForCaller) {
        socket.emit("call:busy", { callId, toUserId: toId, fromUserId: fromId, reason: "busy" });
        return;
      }

      const calleeSocketIds = getSocketIdsForUser(toId);
      if (!calleeSocketIds.length) {
        socket.emit("call:busy", { callId, toUserId: toId, fromUserId: fromId, reason: "offline" });
        return;
      }

      registerCall(callId, fromId, toId);

      io.to(`user:${toId}`).emit("call:incoming", {
        callId,
        fromUserId: fromId,
        toUserId: toId,
        conversationId: payload?.conversationId || null,
        fromName: payload?.fromName || null,
        fromAvatar: payload?.fromAvatar || null,
      });
    });

    socket.on("call:accept", (payload) => {
      const callId = payload?.callId;
      const fromUserId = socketUserId || payload?.fromUserId;
      if (!callId || !fromUserId) return;
      const entry = activeCalls.get(String(callId));
      if (!entry) return;
      const fromId = String(fromUserId);
      const toId = getOtherParty(entry, fromId);
      if (!toId) return;
      io.to(`user:${String(toId)}`).emit("call:accepted", { callId, fromUserId: fromId, toUserId: String(toId) });
    });

    socket.on("call:reject", (payload) => {
      const callId = payload?.callId;
      const fromUserId = socketUserId || payload?.fromUserId;
      if (!callId || !fromUserId) return;
      const entry = activeCalls.get(String(callId));
      if (!entry) return;
      const fromId = String(fromUserId);
      const toId = getOtherParty(entry, fromId);
      if (!toId) return;
      clearCall(callId);
      io.to(`user:${String(toId)}`).emit("call:rejected", {
        callId,
        fromUserId: fromId,
        toUserId: String(toId),
      });
    });

    socket.on("call:signal", (payload) => {
      const callId = payload?.callId;
      const fromUserId = socketUserId || payload?.fromUserId;
      if (!callId || !fromUserId) return;
      const entry = activeCalls.get(String(callId));
      if (!entry) return;
      const fromId = String(fromUserId);
      const expectedOther = getOtherParty(entry, fromId);
      if (!expectedOther) return;
      if (payload?.toUserId && String(payload.toUserId) !== String(expectedOther)) return;
      io.to(`user:${String(expectedOther)}`).emit("call:signal", {
        callId,
        fromUserId: fromId,
        toUserId: String(expectedOther),
        data: payload?.data || null,
      });
    });

    socket.on("call:end", (payload) => {
      const callId = payload?.callId;
      const fromUserId = socketUserId || payload?.fromUserId;
      if (!callId || !fromUserId) return;
      const existingEntry = activeCalls.get(String(callId));
      if (!existingEntry) return;
      const fromId = String(fromUserId);
      const toId = getOtherParty(existingEntry, fromId);
      if (!toId) return;
      const entry = clearCall(callId);
      if (!entry) return;
      io.to(`user:${String(toId)}`).emit("call:ended", {
        callId,
        fromUserId: fromId,
        toUserId: String(toId),
        reason: payload?.reason || "ended",
      });
    });

    socket.on("disconnect", () => {
      if (userId) {
        const typingConversationId = socket.data?.typingConversationId;
        if (typingConversationId && socketUserId) {
          emitTypingEvent({
            conversationId: typingConversationId,
            userId: socketUserId,
            eventName: "typing:stop",
          }).catch(() => {});
          socket.data.typingConversationId = null;
        }

        // 3) Remove socketId from map; user is offline only when all sockets are gone
        const uid = String(userId);
        const set = userSocketIds.get(uid);
        if (set) {
          set.delete(socket.id);
          if (set.size === 0) userSocketIds.delete(uid);
        }

        if (getSocketIdsForUser(uid).length === 0) {
          const callId = userActiveCall.get(uid);
          if (callId) {
            const entry = clearCall(callId);
            if (entry) {
              const otherId = getOtherParty(entry, uid);
              if (otherId) {
                io.to(`user:${String(otherId)}`).emit("call:ended", {
                  callId,
                  fromUserId: uid,
                  toUserId: String(otherId),
                  reason: "disconnect",
                });
              }
            }
          }
          scheduleOfflinePresence(uid);
        }
      }
    });
  });

  return io;
}

export function getIO() {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
}

export function getOnlineUsers() {
  return onlineUsers;
}

// Requirement helpers: userId -> socketId
export function getSocketIdsForUser(userId) {
  const set = userSocketIds.get(String(userId));
  if (!set) return [];
  return Array.from(set);
}

export function getSocketIdForUser(userId) {
  const ids = getSocketIdsForUser(userId);
  return ids.length ? ids[0] : null;
}
