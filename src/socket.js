import { Server } from "socket.io";
import User from "./models/user.model.js";
import Conversation from "./models/conversation.model.js";
import { sendPushNotification } from "./utils/expoPush.js";
import { deliverPendingNotificationsOnReconnect } from "./utils/messageNotifications.js";

let io;
// Presence set (kept for existing features like presence:update)
const onlineUsers = new Set();

// Active audio call tracking (in-memory)
const activeCalls = new Map(); // callId -> { callerId, calleeId, createdAt }
const userActiveCall = new Map(); // userId -> callId

// Requirement: maintain in-memory map userId -> socketId
// Note: users may connect from multiple devices; we store a Set of socketIds.
const userSocketIds = new Map();

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

  io.on("connection", async (socket) => {
    const userId = socket.handshake.auth?.userId || socket.handshake.query?.userId;
    const socketUserId = userId ? String(userId) : null;
    if (userId) {
      // 1) Track socket mapping for real-time notifications
      const uid = String(userId);
      if (!userSocketIds.has(uid)) userSocketIds.set(uid, new Set());
      userSocketIds.get(uid).add(socket.id);

      socket.join(`user:${userId}`);
      onlineUsers.add(uid);
      
      // Update lastActiveAt
      User.findByIdAndUpdate(userId, { lastActiveAt: new Date() }).catch(()=>{});
      io.emit("presence:update", { userId: String(userId), online: true, lastActiveAt: new Date().toISOString() });

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

        const convo = await Conversation.findById(conversationId).select("participants");
        if (!convo?.participants?.length) return;
        const isParticipant = convo.participants.some((id) => String(id) === socketUserId);
        if (!isParticipant) return;
        convo.participants
          .map((id) => String(id))
          .filter((id) => id !== socketUserId)
          .forEach((id) => {
            io.to(`user:${id}`).emit("typing:start", { conversationId, userId: socketUserId });
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

        const convo = await Conversation.findById(conversationId).select("participants");
        if (!convo?.participants?.length) return;
        const isParticipant = convo.participants.some((id) => String(id) === socketUserId);
        if (!isParticipant) return;
        convo.participants
          .map((id) => String(id))
          .filter((id) => id !== socketUserId)
          .forEach((id) => {
            io.to(`user:${id}`).emit("typing:stop", { conversationId, userId: socketUserId });
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
      const existingForCallee = userActiveCall.get(toId);
      const existingForCaller = userActiveCall.get(fromId);
      if (existingForCallee || existingForCaller) {
        socket.emit("call:busy", { callId, toUserId: toId, fromUserId: fromId });
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
      const fromUserId = payload?.fromUserId;
      const toUserId = payload?.toUserId;
      if (!callId || !fromUserId || !toUserId) return;
      const entry = activeCalls.get(String(callId));
      if (!entry) return;
      const fromId = String(fromUserId);
      const toId = String(toUserId);
      if (!getOtherParty(entry, fromId)) return;
      io.to(`user:${toId}`).emit("call:accepted", { callId, fromUserId: fromId, toUserId: toId });
    });

    socket.on("call:reject", (payload) => {
      const callId = payload?.callId;
      const fromUserId = payload?.fromUserId;
      const toUserId = payload?.toUserId;
      if (!callId || !fromUserId || !toUserId) return;
      const entry = activeCalls.get(String(callId));
      if (!entry) return;
      clearCall(callId);
      io.to(`user:${String(toUserId)}`).emit("call:rejected", {
        callId,
        fromUserId: String(fromUserId),
        toUserId: String(toUserId),
      });
    });

    socket.on("call:signal", (payload) => {
      const callId = payload?.callId;
      const fromUserId = payload?.fromUserId;
      const toUserId = payload?.toUserId;
      if (!callId || !fromUserId || !toUserId) return;
      const entry = activeCalls.get(String(callId));
      if (!entry) return;
      const fromId = String(fromUserId);
      const expectedOther = getOtherParty(entry, fromId);
      if (!expectedOther || String(expectedOther) !== String(toUserId)) return;
      io.to(`user:${String(toUserId)}`).emit("call:signal", {
        callId,
        fromUserId: fromId,
        toUserId: String(toUserId),
        data: payload?.data || null,
      });
    });

    socket.on("call:end", (payload) => {
      const callId = payload?.callId;
      const fromUserId = payload?.fromUserId;
      const toUserId = payload?.toUserId;
      if (!callId || !fromUserId || !toUserId) return;
      const entry = clearCall(callId);
      if (!entry) return;
      io.to(`user:${String(toUserId)}`).emit("call:ended", {
        callId,
        fromUserId: String(fromUserId),
        toUserId: String(toUserId),
        reason: payload?.reason || "ended",
      });
    });

    socket.on("disconnect", () => {
      if (userId) {
        // 3) Remove socketId from map; user is offline only when all sockets are gone
        const uid = String(userId);
        const set = userSocketIds.get(uid);
        if (set) {
          set.delete(socket.id);
          if (set.size === 0) userSocketIds.delete(uid);
        }

        // Check if still any sockets in room
        const room = io.sockets.adapter.rooms.get(`user:${userId}`);
        if (!room || room.size === 0) {
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

          onlineUsers.delete(uid);
          const ts = new Date();
          User.findByIdAndUpdate(userId, { lastActiveAt: ts }).catch(()=>{});
          io.emit("presence:update", { userId: String(userId), online: false, lastActiveAt: ts.toISOString() });
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
