import Conversation from "../models/conversation.model.js";
import mongoose from "mongoose";
import Message from "../models/message.model.js";
import User from "../models/user.model.js";
import GroupInvite from "../models/groupInvite.model.js";
import Post from "../models/post.model.js";
import crypto from "crypto";
import { emitMessageDeliveredReceipt, getIO, getOnlineUsers, getSocketIdsForUser } from "../socket.js";
import { sendPushNotification } from "../utils/expoPush.js";
import { buildMessageNotifyPayload, enqueuePendingMessageNotification } from "../utils/messageNotifications.js";
import { decideChatPush } from "../utils/chatPushThrottle.js";
import cloudinary from "cloudinary";

const MESSAGE_LIMIT_DEFAULT = 30;
const MESSAGE_LIMIT_MAX = 100;
const CHAT_MESSAGE_SELECT = "text type mediaUrl mediaDuration post sharedProfile replyTo sender receiver createdAt deleted deletedAt readBy deliveredTo clientMessageId ciphertext nonce payloadType";

function ensureCloudinaryConfigured() {
  const cfg = cloudinary.v2.config();
  if (!cfg.api_key || !cfg.cloud_name) {
    cloudinary.v2.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }
}

function uploadBuffer(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.v2.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    stream.end(buffer);
  });
}

function ensureParticipants(userId, otherId) {
  const a = String(userId);
  const b = String(otherId);
  return a < b ? [a, b] : [b, a];
}

function newInviteCode() {
  return crypto.randomBytes(9).toString("base64url");
}

async function createPendingGroupInvites({ conversationId, inviterId, inviteeIds = [] }) {
  const created = [];
  for (const inviteeId of inviteeIds) {
    try {
      const existing = await GroupInvite.findOne({ conversation: conversationId, invitee: inviteeId, status: "pending" }).select("_id");
      if (existing) continue;
      const invite = await GroupInvite.create({
        conversation: conversationId,
        inviter: inviterId,
        invitee: inviteeId,
        status: "pending",
      });
      created.push(invite);
    } catch (e) {
      // Ignore duplicate key errors for pending invites
      if (e?.code !== 11000) {
        throw e;
      }
    }
  }
  return created;
}

async function getInteractionBlock(userId, otherId) {
  if (!otherId) return { blocked: false };
  const [me, other] = await Promise.all([
    User.findById(userId).select("_id blockedUsers"),
    User.findById(otherId).select("_id blockedUsers"),
  ]);
  if (!other) return { notFound: true };
  const blockedByMe = Array.isArray(me?.blockedUsers) && me.blockedUsers.some((id) => String(id) === String(otherId));
  const blockedByOther = Array.isArray(other.blockedUsers) && other.blockedUsers.some((id) => String(id) === String(userId));
  if (blockedByMe) return { blocked: true, message: "Unblock this user to chat" };
  if (blockedByOther) return { blocked: true, message: "This user has blocked you" };
  return { blocked: false };
}

function ciphertextPreview(ciphertext) {
  if (!ciphertext) return null;
  return `${ciphertext.slice(0, 48)}${ciphertext.length > 48 ? "…" : ""}`;
}

function toAbsoluteUrl(url) {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = process.env.APP_BASE_URL || process.env.BASE_URL;
  if (!base) return url;
  return `${String(base).replace(/\/$/, "")}/${url.replace(/^\//, "")}`;
}

function clampMessageLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) return MESSAGE_LIMIT_DEFAULT;
  return Math.max(1, Math.min(MESSAGE_LIMIT_MAX, Math.floor(parsed)));
}

function normalizeClientMessageId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, 160);
}

function encodeMessageCursor(message) {
  if (!message?._id || !message?.createdAt) return null;
  try {
    return Buffer.from(
      JSON.stringify({
        id: String(message._id),
        at: new Date(message.createdAt).toISOString(),
      })
    ).toString("base64url");
  } catch {
    return null;
  }
}

function decodeMessageCursor(cursor) {
  if (!cursor || typeof cursor !== "string") return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!mongoose.Types.ObjectId.isValid(parsed?.id)) return null;
    const at = new Date(parsed?.at);
    if (Number.isNaN(at.getTime())) return null;
    return { id: new mongoose.Types.ObjectId(parsed.id), at };
  } catch {
    return null;
  }
}

function buildBeforeCursorCondition(cursor) {
  if (!cursor?.id || !cursor?.at) return null;
  return {
    $or: [
      { createdAt: { $lt: cursor.at } },
      { createdAt: cursor.at, _id: { $lt: cursor.id } },
    ],
  };
}

function buildAfterCursorCondition(cursor) {
  if (!cursor?.id || !cursor?.at) return null;
  return {
    $or: [
      { createdAt: { $gt: cursor.at } },
      { createdAt: cursor.at, _id: { $gt: cursor.id } },
    ],
  };
}

function buildMessageQuery({ conversationId, clearedAt, before, beforeCursor, after, afterCursor }) {
  const filters = [{ conversation: conversationId }];
  if (clearedAt) {
    filters.push({ createdAt: { $gte: clearedAt } });
  }
  if (before) {
    const beforeDate = new Date(before);
    if (!Number.isNaN(beforeDate.getTime())) {
      filters.push({ createdAt: { $lt: beforeDate } });
    }
  }
  const decodedBefore = decodeMessageCursor(beforeCursor);
  const beforeCondition = buildBeforeCursorCondition(decodedBefore);
  if (beforeCondition) filters.push(beforeCondition);

  if (after) {
    const afterDate = new Date(after);
    if (!Number.isNaN(afterDate.getTime())) {
      filters.push({ createdAt: { $gt: afterDate } });
    }
  }
  const decodedAfter = decodeMessageCursor(afterCursor);
  const afterCondition = buildAfterCursorCondition(decodedAfter);
  if (afterCondition) filters.push(afterCondition);

  if (filters.length === 1) return filters[0];
  return { $and: filters };
}

function addRealtimeSenderFallbacks(messageToSend) {
  if (messageToSend?.sender && typeof messageToSend.sender === "object") {
    messageToSend.senderName = messageToSend.sender.nickname || messageToSend.sender.name;
    messageToSend.senderAvatarUrl = messageToSend.sender.avatarUrl;
  }
  return messageToSend;
}

async function applyRecipientMessagePrivacy(messageToSend, recipientId) {
  if (!messageToSend) return messageToSend;
  addRealtimeSenderFallbacks(messageToSend);
  if (messageToSend.type === "post" && (!messageToSend.post || messageToSend.post?.isDelete)) {
    messageToSend.post = { unavailable: true, unavailableReason: "deleted" };
    return messageToSend;
  }
  if (
    messageToSend.post &&
    messageToSend.post.visibility === "private" &&
    String(messageToSend.post.author?._id || "") !== String(recipientId || "")
  ) {
    const isFollowing = await User.exists({
      _id: messageToSend.post.author._id,
      followers: recipientId,
    });
    if (!isFollowing) {
      messageToSend.post = { unavailable: true, unavailableReason: "private" };
    }
  }
  return messageToSend;
}

async function populateChatMessage(message, { postDoc, sharedProfileDoc, replyMessageDoc } = {}) {
  await message.populate({ path: "sender", select: "_id name nickname avatarUrl" });
  if (postDoc || sharedProfileDoc || replyMessageDoc) {
    const populateOps = [];
    if (postDoc) {
      populateOps.push({
        path: "post",
        select: "caption media author visibility",
        populate: { path: "author", select: "name avatarUrl" },
      });
    }
    if (sharedProfileDoc) {
      populateOps.push({ path: "sharedProfile", select: "name nickname avatarUrl isPrivate" });
    }
    if (replyMessageDoc) {
      populateOps.push({
        path: "replyTo",
        select: "text type mediaUrl sender deleted createdAt",
        populate: { path: "sender", select: "_id name nickname avatarUrl" },
      });
    }
    await message.populate(populateOps);
  }
  return message;
}

async function broadcastChatMessage({ convo, message, actor, conversationId, previewText }) {
  const io = getIO();
  const onlineUsers = getOnlineUsers();
  if (!io) return;

  const senderId = String(actor._id);
  const senderMessageToSend = addRealtimeSenderFallbacks(message.toObject());
  io.to(`user:${senderId}`).emit("message:new", { conversationId, message: senderMessageToSend });

  const recipients = (convo.participants || []).filter((p) => String(p) !== senderId);
  for (const rid of recipients) {
    const recipientId = String(rid);
    const messageToSend = await applyRecipientMessagePrivacy(message.toObject(), recipientId);
    io.to(`user:${recipientId}`).emit("message:new", { conversationId, message: messageToSend });

    const socketIds = getSocketIdsForUser(recipientId);
    const isOnline = socketIds.length > 0 || onlineUsers.has(recipientId);
    if (isOnline) {
      emitMessageDeliveredReceipt({
        conversationId,
        messageIds: [message._id],
        recipientId,
        senderId,
      });
    }

    const senderUsername = actor.nickname || actor.name || "";
    const senderAvatarUrl = toAbsoluteUrl(actor.avatarUrl) || null;
    const notifyPayload = buildMessageNotifyPayload({
      senderId: actor._id,
      senderUsername,
      senderAvatarUrl,
      conversationId,
      lastMessage: previewText,
      createdAt: message.createdAt,
    });

    if (isOnline) {
      if (socketIds.length) {
        socketIds.forEach((sid) => io.to(sid).emit("message:notify", notifyPayload));
      } else {
        io.to(`user:${recipientId}`).emit("message:notify", notifyPayload);
      }
      continue;
    }

    await enqueuePendingMessageNotification({
      userId: recipientId,
      fromUserId: actor._id,
      conversationId,
      previewText: notifyPayload.lastMessage,
    });

    try {
      const recipient = await User.findById(recipientId).select("pushToken");
      if (!recipient?.pushToken) continue;
      const pushDecision = await decideChatPush({
        userId: recipientId,
        fromUserId: actor._id,
        conversationId,
        previewText: notifyPayload.lastMessage,
      });
      if (!pushDecision.send) continue;

      const pushBody = pushDecision.suppressedSinceLastSend > 0
        ? `${pushDecision.suppressedSinceLastSend + 1} new messages: ${notifyPayload.lastMessage}`
        : notifyPayload.lastMessage;

      await sendPushNotification(
        recipient.pushToken,
        senderUsername || "New message",
        pushBody,
        {
          conversationId,
          senderId: String(actor._id),
          type: "chat_message",
          senderUsername,
          senderAvatarUrl,
        },
        {
          collapseId: `chat:${conversationId}`,
          threadId: `chat:${conversationId}`,
          categoryId: "chat_message",
          image: senderAvatarUrl,
        }
      );
    } catch {}
  }
}

async function upsertDirectConversation(userId, otherId) {
  const [lower, higher] = ensureParticipants(userId, otherId);
  const pairKey = `${lower}:${higher}`;
  let convo = await Conversation.findOne({ directPairKey: pairKey });
  if (!convo) {
    convo = await Conversation.create({ participants: [lower, higher] });
  } else if (Array.isArray(convo.deletedFor) && convo.deletedFor.some((id) => String(id) === String(userId))) {
    convo.deletedFor = convo.deletedFor.filter((id) => String(id) !== String(userId));
    await convo.save();
  }
  return convo;
}

function isFollower(userDoc, followerId) {
  if (!userDoc) return false;
  return userDoc.followers?.some((id) => String(id) === String(followerId)) || false;
}

function hasMessageRequest(userDoc, fromId) {
  if (!userDoc) return false;
  return userDoc.messageRequests?.some((req) => String(req.from) === String(fromId)) || false;
}

async function evaluateChatAccess(meId, targetUser) {
  const follower = isFollower(targetUser, meId);
  if (targetUser.isPrivate && !follower) {
    return { status: "not_allowed_private" };
  }
  if (!targetUser.isPrivate && !follower) {
    return { status: "needs_request" };
  }
  return { status: "chat_allowed" };
}

export const startChat = async (req, res) => {
  try {
    const { targetUserId } = req.params;
    if (String(targetUserId) === String(req.user._id)) {
      return res.status(400).json({ message: "Cannot chat with yourself" });
    }

    const [currentUser, targetUser] = await Promise.all([
      User.findById(req.user._id).select("_id blockedUsers following"),
      User.findById(targetUserId).select("_id name blockedUsers isPrivate followers messageRequests"),
    ]);
    if (!targetUser) return res.status(404).json({ message: "User not found" });

    const blockStatus = await getInteractionBlock(req.user._id, targetUserId);
    if (blockStatus.blocked) return res.status(403).json({ status: "blocked", message: blockStatus.message });

    const access = await evaluateChatAccess(req.user._id, targetUser);
    if (access.status === "not_allowed_private") {
      return res.status(403).json({ status: "not_allowed_private" });
    }

    if (access.status === "needs_request") {
      if (!hasMessageRequest(targetUser, req.user._id)) {
        targetUser.messageRequests.push({ from: req.user._id });
        await targetUser.save();
      }
      return res.json({ status: "request_sent" });
    }

    const convo = await upsertDirectConversation(req.user._id, targetUserId);
    return res.json({ status: "chat_allowed", chatId: convo._id, conversation: convo });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const listMessageRequests = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select("messageRequests")
      .populate("messageRequests.from", "name nickname avatarUrl isPrivate");
    res.json({ requests: user?.messageRequests || [] });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

async function handleMessageRequestDecision(req, res, accepted) {
  const { requesterId } = req.params;
  const user = await User.findById(req.user._id);
  if (!user) return res.status(404).json({ message: "User not found" });

  const before = user.messageRequests.length;
  user.messageRequests = user.messageRequests.filter((entry) => String(entry.from) !== String(requesterId));
  if (before === user.messageRequests.length) {
    await user.save();
    return res.status(404).json({ message: "Request not found" });
  }
  await user.save();

  if (!accepted) {
    return res.json({ status: "rejected" });
  }

  const convo = await upsertDirectConversation(req.user._id, requesterId);
  return res.json({ status: "accepted", chatId: convo._id });
}

export const acceptMessageRequest = async (req, res) => {
  try {
    await handleMessageRequestDecision(req, res, true);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const rejectMessageRequest = async (req, res) => {
  try {
    await handleMessageRequestDecision(req, res, false);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const getOrCreateConversation = async (req, res) => {
  try {
    const otherId = req.params.userId;
    if (String(otherId) === String(req.user._id)) return res.status(400).json({ message: "Cannot chat with yourself" });
    const blockStatus = await getInteractionBlock(req.user._id, otherId);
    if (blockStatus.notFound) return res.status(404).json({ message: "User not found" });
    if (blockStatus.blocked) return res.status(403).json({ message: blockStatus.message });

    const target = await User.findById(otherId).select("isPrivate followers messageRequests");
    if (!target) return res.status(404).json({ message: "User not found" });
    const access = await evaluateChatAccess(req.user._id, target);
    if (access.status === "not_allowed_private") {
      return res.status(403).json({ message: "Follow request must be accepted before chatting" });
    }
    if (access.status === "needs_request") {
      if (!hasMessageRequest(target, req.user._id)) {
        target.messageRequests.push({ from: req.user._id });
        await target.save();
      }
      return res.status(202).json({ message: "Message request sent" });
    }

    const convo = await upsertDirectConversation(req.user._id, otherId);
    res.json({ conversation: convo });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const createGroupConversation = async (req, res) => {
  try {
    const { name, participantIds = [], photoUrl = null } = req.body;
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) return res.status(400).json({ message: "Group name is required" });

    const rawIds = [String(req.user._id), ...(Array.isArray(participantIds) ? participantIds.map(String) : [])];
    const invalidIds = rawIds.filter((id) => !mongoose.Types.ObjectId.isValid(id));
    if (invalidIds.length) return res.status(400).json({ message: "One or more users are invalid" });
    const ids = new Set(rawIds);

    const validUsers = await User.find({ _id: { $in: Array.from(ids) } }).select('_id name allowGroupAdds');
    if (validUsers.length !== ids.size) return res.status(400).json({ message: "One or more users are invalid" });

    const allowedIds = new Set([String(req.user._id)]);
    const skipped = [];
    validUsers.forEach((u) => {
      const id = String(u._id);
      if (id === String(req.user._id)) return;
      if (u.allowGroupAdds === false) {
        skipped.push({ _id: u._id, name: u.name });
      } else {
        allowedIds.add(id);
      }
    });

    const convo = await Conversation.create({
      isGroup: true,
      name: trimmed,
      photoUrl,
      participants: Array.from(allowedIds),
      admins: [req.user._id],
      createdBy: req.user._id,
      inviteCode: newInviteCode(),
      inviteEnabled: true,
    });
    if (skipped.length) {
      await createPendingGroupInvites({
        conversationId: convo._id,
        inviterId: req.user._id,
        inviteeIds: skipped.map((u) => u._id),
      });
    }
    const populated = await Conversation.findById(convo._id).populate("participants", "_id name nickname avatarUrl verified isVerified verificationType");
    res.status(201).json({ conversation: populated, skipped });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const updateGroupConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { name, photoUrl, inviteEnabled } = req.body;
    const convo = await Conversation.findById(conversationId);
    if (!convo || !convo.isGroup) return res.status(404).json({ message: "Group not found" });
    const isAdmin = convo.admins?.some((id) => String(id) === String(req.user._id));
    if (!isAdmin) return res.status(403).json({ message: "Admin access required" });

    if (typeof name === 'string') convo.name = name.trim() || convo.name;
    if (typeof photoUrl === 'string' || photoUrl === null) convo.photoUrl = photoUrl;
    if (typeof inviteEnabled === 'boolean') convo.inviteEnabled = inviteEnabled;

    await convo.save();
    const populated = await Conversation.findById(convo._id).populate("participants", "_id name nickname avatarUrl verified isVerified verificationType");
    res.json({ conversation: populated });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const addGroupMembers = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { memberIds = [] } = req.body;
    const convo = await Conversation.findById(conversationId);
    if (!convo || !convo.isGroup) return res.status(404).json({ message: "Group not found" });
    const isAdmin = convo.admins?.some((id) => String(id) === String(req.user._id));
    if (!isAdmin) return res.status(403).json({ message: "Admin access required" });

    const current = new Set((convo.participants || []).map((id) => String(id)));
    const toAdd = Array.isArray(memberIds) ? memberIds.map(String) : [];
    const invalidIds = toAdd.filter((id) => !mongoose.Types.ObjectId.isValid(id));
    if (invalidIds.length) return res.status(400).json({ message: "One or more users are invalid" });
    const validUsers = await User.find({ _id: { $in: Array.from(toAdd) } }).select('_id name allowGroupAdds');
    if (validUsers.length !== toAdd.length) return res.status(400).json({ message: "One or more users are invalid" });

    const allowedToAdd = [];
    const skipped = [];
    validUsers.forEach((u) => {
      if (u.allowGroupAdds === false) {
        skipped.push({ _id: u._id, name: u.name });
      } else {
        allowedToAdd.push(String(u._id));
      }
    });

    const merged = new Set([...current, ...allowedToAdd]);
    convo.participants = Array.from(merged);
    await convo.save();
    if (skipped.length) {
      await createPendingGroupInvites({
        conversationId: convo._id,
        inviterId: req.user._id,
        inviteeIds: skipped.map((u) => u._id),
      });
    }
    const populated = await Conversation.findById(convo._id).populate("participants", "_id name nickname avatarUrl verified isVerified verificationType");
    res.json({ conversation: populated, skipped });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const removeGroupMember = async (req, res) => {
  try {
    const { conversationId, memberId } = req.params;
    const convo = await Conversation.findById(conversationId);
    if (!convo || !convo.isGroup) return res.status(404).json({ message: "Group not found" });
    const isAdmin = convo.admins?.some((id) => String(id) === String(req.user._id));
    if (!isAdmin) return res.status(403).json({ message: "Admin access required" });

    const memberIdStr = String(memberId);
    const participants = (convo.participants || []).map((id) => String(id));
    if (!participants.includes(memberIdStr)) return res.status(404).json({ message: "Member not found" });

    const admins = (convo.admins || []).map((id) => String(id));
    const removingAdmin = admins.includes(memberIdStr);
    const remainingAdmins = admins.filter((id) => id !== memberIdStr);
    if (removingAdmin && remainingAdmins.length === 0) {
      return res.status(400).json({ message: "Cannot remove the last admin" });
    }

    convo.participants = participants.filter((id) => id !== memberIdStr);
    convo.admins = remainingAdmins;
    await convo.save();
    const populated = await Conversation.findById(convo._id).populate("participants", "_id name nickname avatarUrl verified isVerified verificationType");
    res.json({ conversation: populated });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const addGroupAdmin = async (req, res) => {
  try {
    const { conversationId, memberId } = req.params;
    const convo = await Conversation.findById(conversationId);
    if (!convo || !convo.isGroup) return res.status(404).json({ message: "Group not found" });
    const isAdmin = convo.admins?.some((id) => String(id) === String(req.user._id));
    if (!isAdmin) return res.status(403).json({ message: "Admin access required" });

    const memberIdStr = String(memberId);
    if (!convo.participants.some((id) => String(id) === memberIdStr)) {
      return res.status(404).json({ message: "Member not found" });
    }
    await Conversation.findByIdAndUpdate(
      convo._id,
      { $addToSet: { admins: memberIdStr } },
      { new: false }
    );
    const populated = await Conversation.findById(convo._id).populate("participants", "_id name nickname avatarUrl verified isVerified verificationType");
    res.json({ conversation: populated });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const removeGroupAdmin = async (req, res) => {
  try {
    const { conversationId, memberId } = req.params;
    const convo = await Conversation.findById(conversationId);
    if (!convo || !convo.isGroup) return res.status(404).json({ message: "Group not found" });
    const isAdmin = convo.admins?.some((id) => String(id) === String(req.user._id));
    if (!isAdmin) return res.status(403).json({ message: "Admin access required" });

    const admins = (convo.admins || []).map((id) => String(id));
    const memberIdStr = String(memberId);
    const remainingAdmins = admins.filter((id) => id !== memberIdStr);
    if (remainingAdmins.length === 0) return res.status(400).json({ message: "At least one admin is required" });

    await Conversation.findByIdAndUpdate(
      convo._id,
      { $set: { admins: remainingAdmins } },
      { new: false }
    );
    const populated = await Conversation.findById(convo._id).populate("participants", "_id name nickname avatarUrl verified isVerified verificationType");
    res.json({ conversation: populated });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const leaveGroup = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const convo = await Conversation.findById(conversationId);
    if (!convo || !convo.isGroup) return res.status(404).json({ message: "Group not found" });

    const userId = String(req.user._id);
    const participants = (convo.participants || []).map((id) => String(id));
    if (!participants.includes(userId)) return res.status(404).json({ message: "Member not found" });

    const admins = (convo.admins || []).map((id) => String(id));
    const removingAdmin = admins.includes(userId);
    const remainingAdmins = admins.filter((id) => id !== userId);
    if (removingAdmin && remainingAdmins.length === 0 && participants.length > 1) {
      return res.status(400).json({ message: "Assign another admin before leaving" });
    }

    convo.participants = participants.filter((id) => id !== userId);
    convo.admins = remainingAdmins;

    if (convo.participants.length === 0) {
      await Conversation.deleteOne({ _id: convo._id });
      await Message.deleteMany({ conversation: convo._id }).catch(() => {});
      return res.json({ left: true, deleted: true });
    }

    await convo.save();
    res.json({ left: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const generateGroupInvite = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const convo = await Conversation.findById(conversationId);
    if (!convo || !convo.isGroup) return res.status(404).json({ message: "Group not found" });
    const isAdmin = convo.admins?.some((id) => String(id) === String(req.user._id));
    if (!isAdmin) return res.status(403).json({ message: "Admin access required" });
    convo.inviteCode = newInviteCode();
    convo.inviteEnabled = true;
    await convo.save();
    res.json({ inviteCode: convo.inviteCode });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const joinGroupByInvite = async (req, res) => {
  try {
    const { inviteCode } = req.params;
    const convo = await Conversation.findOne({ inviteCode, inviteEnabled: true });
    if (!convo || !convo.isGroup) return res.status(404).json({ message: "Invite not found" });
    const participants = new Set((convo.participants || []).map((id) => String(id)));
    participants.add(String(req.user._id));
    convo.participants = Array.from(participants);
    await convo.save();
    const populated = await Conversation.findById(convo._id).populate("participants", "_id name nickname avatarUrl verified isVerified verificationType");
    res.json({ conversation: populated });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const listGroupInvites = async (req, res) => {
  try {
    const invites = await GroupInvite.find({ invitee: req.user._id, status: "pending" })
      .sort({ createdAt: -1 })
      .populate("conversation", "_id name photoUrl isGroup participants")
      .populate("inviter", "_id name nickname avatarUrl isVerified verificationType");

    res.json({ invites });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const respondGroupInvite = async (req, res) => {
  try {
    const { inviteId } = req.params;
    const action = String(req.body?.action || '').toLowerCase();
    if (!['accept', 'decline'].includes(action)) {
      return res.status(400).json({ message: "Action must be accept or decline" });
    }

    const invite = await GroupInvite.findOne({ _id: inviteId, invitee: req.user._id });
    if (!invite) return res.status(404).json({ message: "Invite not found" });
    if (invite.status !== 'pending') {
      return res.status(400).json({ message: "Invite already handled" });
    }

    let conversation = null;
    if (action === 'accept') {
      conversation = await Conversation.findById(invite.conversation);
      if (!conversation || !conversation.isGroup) {
        return res.status(404).json({ message: "Group not found" });
      }
      const participants = new Set((conversation.participants || []).map((id) => String(id)));
      participants.add(String(req.user._id));
      conversation.participants = Array.from(participants);
      await conversation.save();
      conversation = await Conversation.findById(conversation._id).populate("participants", "_id name nickname avatarUrl verified isVerified verificationType");
    }

    invite.status = action === 'accept' ? 'accepted' : 'declined';
    await invite.save();

    res.json({ invite, conversation });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const listConversations = async (req, res) => {
  try {
    const convos = await Conversation.find({ participants: req.user._id, deletedFor: { $ne: req.user._id } })
      .sort({ updatedAt: -1 })
      .limit(50)
      .populate("participants", "_id name nickname email avatarUrl verified isVerified verificationType");

    const userId = String(req.user._id);
    const withMeta = await Promise.all(
      convos.map(async (c) => {
        const clearedAt = Array.isArray(c.clearedFor)
          ? c.clearedFor.find((entry) => String(entry.user) === userId)?.clearedAt
          : null;
        const timeFilter = clearedAt ? { createdAt: { $gte: clearedAt } } : {};
        const [unread, last] = await Promise.all([
          Message.countDocuments({ conversation: c._id, readBy: { $ne: userId }, ...timeFilter }),
          Message.findOne({ conversation: c._id, ...timeFilter })
            .sort({ createdAt: -1 })
            .select("text type payloadType createdAt deleted")
            .lean()
            .catch(() => null),
        ]);
        const obj = c.toObject();
        obj.unreadCount = unread;
        obj.isFavorite = Array.isArray(c.favorites) && c.favorites.some((id) => String(id) === userId);
        obj.lastMessage = last
          ? {
              text: last.deleted ? null : last.text,
              type: last.type,
              payloadType: last.payloadType,
              createdAt: last.createdAt,
              deleted: Boolean(last.deleted),
            }
          : null;
        return obj;
      })
    );
    res.json({ conversations: withMeta });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const getConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const convo = await Conversation.findById(conversationId).populate(
      "participants",
      "_id name nickname email avatarUrl verified isVerified verificationType"
    );
    if (!convo || !convo.participants.some((p) => String(p?._id || p) === String(req.user._id))) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const userId = String(req.user._id);
    const clearedAt = Array.isArray(convo.clearedFor)
      ? convo.clearedFor.find((entry) => String(entry.user) === userId)?.clearedAt
      : null;
    const timeFilter = clearedAt ? { createdAt: { $gte: clearedAt } } : {};
    const [unread, last] = await Promise.all([
      Message.countDocuments({ conversation: convo._id, readBy: { $ne: userId }, ...timeFilter }),
      Message.findOne({ conversation: convo._id, ...timeFilter })
        .sort({ createdAt: -1 })
        .select("text type payloadType createdAt deleted")
        .lean()
        .catch(() => null),
    ]);

    const obj = convo.toObject();
    obj.unreadCount = unread;
    obj.isFavorite = Array.isArray(convo.favorites) && convo.favorites.some((id) => String(id) === userId);
    obj.lastMessage = last
      ? {
          text: last.deleted ? null : last.text,
          type: last.type,
          payloadType: last.payloadType,
          createdAt: last.createdAt,
          deleted: Boolean(last.deleted),
        }
      : null;

    res.json({ conversation: obj });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const favoriteConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const convo = await Conversation.findById(conversationId);
    if (!convo || !convo.participants.some((p) => String(p) === String(req.user._id))) {
      return res.status(404).json({ message: "Conversation not found" });
    }
    const userId = String(req.user._id);
    const favs = new Set((convo.favorites || []).map((id) => String(id)));
    favs.add(userId);
    convo.favorites = Array.from(favs);
    await convo.save();
    res.json({ conversationId, isFavorite: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const unfavoriteConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const convo = await Conversation.findById(conversationId);
    if (!convo || !convo.participants.some((p) => String(p) === String(req.user._id))) {
      return res.status(404).json({ message: "Conversation not found" });
    }
    const userId = String(req.user._id);
    convo.favorites = (convo.favorites || []).filter((id) => String(id) !== userId);
    await convo.save();
    res.json({ conversationId, isFavorite: false });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const listMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const {
      before,
      beforeCursor,
      after,
      afterCursor,
      limit = MESSAGE_LIMIT_DEFAULT,
    } = req.query;
    const convo = await Conversation.findById(conversationId);
    if (!convo || !convo.participants.some((p) => String(p) === String(req.user._id))) {
      return res.status(404).json({ message: "Conversation not found" });
    }
    if (!convo.isGroup) {
      const others = convo.participants.filter((p) => String(p) !== String(req.user._id));
      for (const participant of others) {
        const blockStatus = await getInteractionBlock(req.user._id, participant);
        if (blockStatus.notFound) return res.status(404).json({ message: "User not found" });
        if (blockStatus.blocked) return res.status(403).json({ message: blockStatus.message });
      }
    }
    const clearedAt = Array.isArray(convo.clearedFor)
      ? convo.clearedFor.find((entry) => String(entry.user) === String(req.user._id))?.clearedAt
      : null;
    const query = buildMessageQuery({
      conversationId,
      clearedAt,
      before,
      beforeCursor,
      after,
      afterCursor,
    });
    const isDeltaSync = Boolean(after || afterCursor);
    const safeLimit = clampMessageLimit(limit);

    let msgs = await Message.find(query)
      .sort(isDeltaSync ? { createdAt: 1, _id: 1 } : { createdAt: -1, _id: -1 })
      .limit(safeLimit)
      .select(CHAT_MESSAGE_SELECT)
      .populate({ path: "sender", select: "name nickname avatarUrl isVerified verificationType" })
      .populate({
        path: "post",
        select: "caption media author visibility isDelete createdAt",
        populate: { path: "author", select: "name avatarUrl" }
      })
      .populate({ path: "sharedProfile", select: "name nickname avatarUrl isPrivate" })
      .populate({
        path: "replyTo",
        select: "text type mediaUrl sender deleted createdAt",
        populate: { path: "sender", select: "name nickname avatarUrl" }
      })
      .lean();

    const orderedMessages = isDeltaSync ? msgs : msgs.slice().reverse();

    // If a shared post was deleted/removed, represent it as unavailable.
    // This mirrors Instagram-style behavior: keep the message bubble, but show an unavailable card.
    for (const msg of orderedMessages) {
      if (msg.type === 'post') {
        if (!msg.post || msg.post?.isDelete) {
          msg.post = { unavailable: true, unavailableReason: 'deleted' };
        }
      }
    }

    // Privacy Check: Hide private posts if viewer doesn't follow author
    const viewerId = String(req.user._id);
    const privatePostAuthors = new Set();

    for (const msg of orderedMessages) {
      if (msg.post && msg.post.visibility === 'private' && msg.post.author && String(msg.post.author._id) !== viewerId) {
        privatePostAuthors.add(String(msg.post.author._id));
      }
    }

    if (privatePostAuthors.size > 0) {
      const following = await User.find({ 
        _id: { $in: Array.from(privatePostAuthors) }, 
        followers: req.user._id 
      }).select('_id');
      
      const followingSet = new Set(following.map(u => String(u._id)));

      for (const msg of orderedMessages) {
        if (msg.post && msg.post.visibility === 'private' && msg.post.author && String(msg.post.author._id) !== viewerId) {
          if (!followingSet.has(String(msg.post.author._id))) {
             msg.post = { unavailable: true, unavailableReason: 'private' };
          }
        }
      }
    }

    const syncCursor = orderedMessages.length
      ? encodeMessageCursor(orderedMessages[orderedMessages.length - 1])
      : decodeMessageCursor(afterCursor)
      ? afterCursor
      : null;
    const nextCursor = !isDeltaSync && orderedMessages.length
      ? encodeMessageCursor(orderedMessages[0])
      : null;

    res.json({
      messages: orderedMessages,
      syncCursor,
      nextCursor,
      hasMore: !isDeltaSync && orderedMessages.length === safeLimit,
      mode: isDeltaSync ? "delta" : "history",
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const sendMessage = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const {
      text,
      payloadType: requestedPayloadType = "text",
      type,
      media,
      postId,
      profileId,
      replyTo,
      clientMessageId,
      ciphertext,
      nonce,
      envelope,
    } = req.body;
    const payloadType = type || requestedPayloadType || "text";
    const normalizedCiphertext = typeof ciphertext === "string"
      ? ciphertext
      : typeof envelope?.ciphertext === "string"
      ? envelope.ciphertext
      : null;
    const normalizedNonce = typeof nonce === "string"
      ? nonce
      : typeof envelope?.nonce === "string"
      ? envelope.nonce
      : null;
    if (!text && !media && !postId && !profileId && !normalizedCiphertext) {
      return res.status(400).json({ message: "Text, media, post, profile, or ciphertext required" });
    }
    const normalizedClientMessageId = normalizeClientMessageId(clientMessageId);

    // Validate post share
    let postDoc = null;
    if (payloadType === "post") {
      if (!postId || !mongoose.Types.ObjectId.isValid(postId)) {
        return res.status(400).json({ message: "Invalid postId" });
      }
      postDoc = await Post.findById(postId).populate("author", "name avatarUrl isPrivate followers");
      if (!postDoc || postDoc.isDelete || postDoc.isDeleted) {
        return res.status(404).json({ message: "Post not found" });
      }
    }

    // Validate profile share
    let sharedProfileDoc = null;
    if (payloadType === "profile") {
      if (!profileId || !mongoose.Types.ObjectId.isValid(profileId)) {
        return res.status(400).json({ message: "Invalid profileId" });
      }
      sharedProfileDoc = await User.findById(profileId).select("name nickname avatarUrl isPrivate");
      if (!sharedProfileDoc) {
        return res.status(404).json({ message: "Profile not found" });
      }
    }

    const convo = await Conversation.findById(conversationId);
    if (!convo || !convo.participants.some((p) => String(p) === String(req.user._id))) {
      return res.status(404).json({ message: "Conversation not found" });
    }
    const isGroup = !!convo.isGroup;
    const receiverId = isGroup ? null : convo.participants.find((p) => String(p) !== String(req.user._id));
    if (!isGroup) {
      const blockStatus = await getInteractionBlock(req.user._id, receiverId);
      if (blockStatus.blocked) return res.status(403).json({ message: blockStatus.message });
    }

    if (normalizedClientMessageId) {
      const existingMessage = await Message.findOne({
        conversation: conversationId,
        sender: req.user._id,
        clientMessageId: normalizedClientMessageId,
      })
        .select(CHAT_MESSAGE_SELECT)
        .populate({ path: "sender", select: "name nickname avatarUrl isVerified verificationType" })
        .populate({
          path: "post",
          select: "caption media author visibility isDelete createdAt",
          populate: { path: "author", select: "name avatarUrl" }
        })
        .populate({ path: "sharedProfile", select: "name nickname avatarUrl isPrivate" })
        .populate({
          path: "replyTo",
          select: "text type mediaUrl sender deleted createdAt",
          populate: { path: "sender", select: "name nickname avatarUrl" }
        });
      if (existingMessage) {
        return res.status(200).json({ message: existingMessage, duplicate: true });
      }
    }

    let replyMessageDoc = null;
    if (replyTo) {
      if (!mongoose.Types.ObjectId.isValid(replyTo)) {
        return res.status(400).json({ message: "Invalid replyTo" });
      }
      replyMessageDoc = await Message.findOne({ _id: replyTo, conversation: conversationId });
      if (!replyMessageDoc) {
        return res.status(404).json({ message: "Reply target not found" });
      }
    }

    const messageData = {
      conversation: conversationId,
      sender: req.user._id,
      receiver: receiverId,
      text: text || (payloadType === "profile" ? "Shared profile" : ciphertextPreview(normalizedCiphertext) || ""),
      type: payloadType,
      payloadType,
      readBy: [req.user._id],
      clientMessageId: normalizedClientMessageId,
    };

    const recipients = convo.participants
      .map((entry) => String(entry))
      .filter((entry) => entry !== String(req.user._id));
    const onlineUsers = getOnlineUsers();
    const deliveredRecipientIds = recipients.filter((rid) => {
      const socketIds = getSocketIdsForUser(rid);
      return socketIds.length > 0 || onlineUsers.has(rid);
    });
    if (deliveredRecipientIds.length) {
      messageData.deliveredTo = deliveredRecipientIds;
    }

    if (postDoc) {
      messageData.post = postDoc._id;
    }

    if (sharedProfileDoc) {
      messageData.sharedProfile = sharedProfileDoc._id;
    }

    if (replyMessageDoc) {
      messageData.replyTo = replyMessageDoc._id;
    }

    if (normalizedCiphertext) {
      messageData.ciphertext = normalizedCiphertext;
    }

    if (normalizedNonce) {
      messageData.nonce = normalizedNonce;
    }

    // Include media if provided
    if (media && media.url) {
      messageData.mediaUrl = media.url;
      if (media.duration) messageData.mediaDuration = media.duration;
    }

    const message = await Message.create(messageData);
    await populateChatMessage(message, { postDoc, sharedProfileDoc, replyMessageDoc });

    const previewText = text
      ? text
      : ciphertextPreview(normalizedCiphertext) || `[${payloadType}]`;

    convo.lastMessage = {
      text: previewText.length > 50 ? previewText.slice(0, 50) + "…" : previewText,
      msgType: payloadType,
      sender: req.user._id,
      at: message.createdAt,
    };
    await convo.save();

    await broadcastChatMessage({
      convo,
      message,
      actor: req.user,
      conversationId,
      previewText,
    });

    res.status(201).json({ message });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const uploadChatMedia = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const convo = await Conversation.findById(conversationId);
    if (!convo || !convo.participants.some((p) => String(p) === String(req.user._id))) {
      return res.status(404).json({ message: "Conversation not found" });
    }
    const receiverId = convo.participants.find((p) => String(p) !== String(req.user._id));
    const blockStatus = await getInteractionBlock(req.user._id, receiverId);
    if (blockStatus.blocked) return res.status(403).json({ message: blockStatus.message });
    if (!req.file) return res.status(400).json({ message: "No file provided" });

    ensureCloudinaryConfigured();
    const mime = req.file.mimetype || "";
    const isVideo = mime.startsWith("video/");
    const isAudio = mime.startsWith("audio/");
    const mediaType = isAudio ? "audio" : isVideo ? "video" : "image";
    const resourceType = mediaType === "image" ? "image" : "video";
    const folder = `flowsnap/chats/${conversationId}`;

    const result = await uploadBuffer(req.file.buffer, {
      folder,
      resource_type: resourceType,
      overwrite: false,
    });

    const media = {
      url: result.secure_url,
      type: mediaType,
      publicId: result.public_id,
      width: result.width,
      height: result.height,
      durationSeconds: result.duration ? Math.round(result.duration) : undefined,
    };

    res.status(201).json({ media });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const markRead = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const convo = await Conversation.findById(conversationId);
    if (!convo || !convo.participants.some((p) => String(p) === String(req.user._id))) {
      return res.status(404).json({ message: "Conversation not found" });
    }
    const clearedAt = Array.isArray(convo.clearedFor)
      ? convo.clearedFor.find((entry) => String(entry.user) === String(req.user._id))?.clearedAt
      : null;
    const readFilter = { conversation: conversationId, readBy: { $ne: req.user._id } };
    if (clearedAt) readFilter.createdAt = { $gte: clearedAt };
    await Message.updateMany(readFilter, {
      $addToSet: { readBy: req.user._id, deliveredTo: req.user._id },
    });
    const io = getIO();
    const recipients = (convo.participants || []).filter((p) => String(p) !== String(req.user._id));
    recipients.forEach((rid) => {
      io.to(`user:${rid}`).emit("message:read", {
        conversationId: String(convo._id),
        readerId: String(req.user._id),
      });
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const clearConversationForUser = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const convo = await Conversation.findById(conversationId);
    if (!convo || !convo.participants.some((p) => String(p) === String(req.user._id))) {
      return res.status(404).json({ message: "Conversation not found" });
    }

    const now = new Date();
    const userId = String(req.user._id);
    const clearedFor = Array.isArray(convo.clearedFor) ? convo.clearedFor : [];
    const idx = clearedFor.findIndex((entry) => String(entry.user) === userId);
    if (idx >= 0) {
      clearedFor[idx].clearedAt = now;
    } else {
      clearedFor.push({ user: req.user._id, clearedAt: now });
    }
    convo.clearedFor = clearedFor;
    // Ensure conversation remains visible for this user
    if (Array.isArray(convo.deletedFor) && convo.deletedFor.some((id) => String(id) === userId)) {
      convo.deletedFor = convo.deletedFor.filter((id) => String(id) !== userId);
    }
    await convo.save();

    res.json({ ok: true, clearedAt: now.toISOString() });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const msg = await Message.findById(messageId);
    if (!msg) return res.status(404).json({ message: "Message not found" });
    if (String(msg.sender) !== String(req.user._id)) return res.status(403).json({ message: "Not allowed" });
    const convo = await Conversation.findById(msg.conversation);
    if (!convo || !convo.participants.some((p) => String(p) === String(req.user._id))) {
      return res.status(404).json({ message: "Conversation not found" });
    }
    if (msg.deleted) return res.json({ message: msg });

    msg.deleted = true;
    msg.deletedAt = new Date();
    msg.deletedBy = req.user._id;
    msg.text = "";
    msg.mediaUrl = null;
    // Clear legacy encryption fields if present
    msg.ciphertext = "";
    msg.nonce = "";
    await msg.save();

    if (convo.lastMessage && String(convo.lastMessage.sender) === String(req.user._id)) {
      convo.lastMessage.text = "[deleted]";
      convo.lastMessage.at = new Date();
      await convo.save();
    }

    const io = getIO();
    if (io) {
      const recipients = convo.participants.filter((p) => String(p) !== String(req.user._id));
      recipients.forEach((rid) => {
        io.to(`user:${rid}`).emit("message:deleted", {
          conversationId: String(convo._id),
          messageId: String(msg._id),
        });
      });
    }

    res.json({ message: msg });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const deleteConversationForUser = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const convo = await Conversation.findOneAndUpdate(
      { _id: conversationId, participants: req.user._id },
      { $addToSet: { deletedFor: req.user._id } },
      { new: true }
    );
    if (!convo) return res.status(404).json({ message: "Conversation not found" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const replyFromNotification = async (req, res) => {
  try {
    const { conversationId, text, clientMessageId } = req.body;
    if (!conversationId || !text) return res.status(400).json({ message: "Missing fields" });
    const normalizedClientMessageId = normalizeClientMessageId(clientMessageId);

    const convo = await Conversation.findById(conversationId);
    if (!convo || !convo.participants.some((p) => String(p) === String(req.user._id))) {
      return res.status(404).json({ message: "Conversation not found" });
    }
    
    const receiverId = convo.participants.find((p) => String(p) !== String(req.user._id));
    if (normalizedClientMessageId) {
      const existingMessage = await Message.findOne({
        conversation: conversationId,
        sender: req.user._id,
        clientMessageId: normalizedClientMessageId,
      })
        .select(CHAT_MESSAGE_SELECT)
        .populate({ path: "sender", select: "name nickname avatarUrl isVerified verificationType" });
      if (existingMessage) {
        return res.status(200).json({ message: existingMessage, duplicate: true });
      }
    }
    const recipients = convo.participants
      .map((entry) => String(entry))
      .filter((entry) => entry !== String(req.user._id));
    const onlineUsers = getOnlineUsers();
    const deliveredRecipientIds = recipients.filter((rid) => {
      const socketIds = getSocketIdsForUser(rid);
      return socketIds.length > 0 || onlineUsers.has(rid);
    });
    
    const messageData = {
      conversation: conversationId,
      sender: req.user._id,
      receiver: receiverId,
      text: text,
      type: "text",
      readBy: [req.user._id],
      clientMessageId: normalizedClientMessageId,
    };
    if (deliveredRecipientIds.length) {
      messageData.deliveredTo = deliveredRecipientIds;
    }

    const message = await Message.create(messageData);
    await populateChatMessage(message);

    convo.lastMessage = {
      text: text.length > 50 ? text.slice(0, 50) + "…" : text,
      sender: req.user._id,
      at: message.createdAt,
    };
    await convo.save();

    await broadcastChatMessage({
      convo,
      message,
      actor: req.user,
      conversationId,
      previewText: text,
    });

    res.status(201).json({ message });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};
