import PendingNotification from "../models/pendingNotification.model.js";

function toAbsoluteUrl(url) {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = process.env.APP_BASE_URL || process.env.BASE_URL;
  if (!base) return url;
  return `${String(base).replace(/\/$/, "")}/${url.replace(/^\//, "")}`;
}

function toSingleLinePreview(text, maxLen = 80) {
  const raw = typeof text === "string" ? text : "";
  const oneLine = raw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, Math.max(0, maxLen - 1)).trimEnd() + "…";
}

/**
 * Build the Socket.IO payload for the Instagram-like in-app banner.
 * Required fields:
 * - senderId
 * - senderUsername
 * - lastMessage (single line)
 * - conversationId
 * - timestamp
 */
export function buildMessageNotifyPayload({
  senderId,
  senderUsername,
  senderAvatarUrl = null,
  conversationId,
  lastMessage,
  createdAt,
}) {
  const preview = toSingleLinePreview(lastMessage);
  return {
    senderId: String(senderId),
    senderUsername: senderUsername || "",
    senderAvatarUrl: senderAvatarUrl || null,
    lastMessage: preview,
    conversationId: String(conversationId),
    timestamp: (createdAt ? new Date(createdAt) : new Date()).toISOString(),
  };
}

/**
 * Persist an undelivered notification for an offline user.
 */
export async function enqueuePendingMessageNotification({
  userId,
  fromUserId,
  conversationId,
  previewText,
}) {
  return PendingNotification.create({
    userId,
    type: "MESSAGE",
    fromUserId,
    conversationId,
    previewText: toSingleLinePreview(previewText),
    isDelivered: false,
  });
}

/**
 * Deliver all pending notifications to a newly connected socket and mark them delivered.
 *
 * Emits one-by-one to preserve ordering and match the requirement.
 */
export async function deliverPendingNotificationsOnReconnect({ io, userId, socketId }) {
  const uid = String(userId);
  const pending = await PendingNotification.find({ userId: uid, isDelivered: false })
    .sort({ createdAt: 1 })
    .limit(200)
    .populate({ path: "fromUserId", select: "_id name nickname avatarUrl" });

  if (!pending.length) return { delivered: 0 };

  for (const note of pending) {
    const from = note.fromUserId;
    const senderUsername =
      (from && typeof from === "object" ? (from.nickname || from.name) : null) || "";
    const senderAvatarUrl =
      (from && typeof from === "object" ? toAbsoluteUrl(from.avatarUrl) : null) || null;

    io.to(socketId).emit("message:notify", {
      senderId: String((from && typeof from === "object" ? from._id : note.fromUserId)),
      senderUsername,
      senderAvatarUrl,
      lastMessage: note.previewText || "",
      conversationId: String(note.conversationId),
      timestamp: new Date(note.createdAt).toISOString(),
      _pendingId: String(note._id),
    });

    await PendingNotification.updateOne(
      { _id: note._id, isDelivered: false },
      { $set: { isDelivered: true, deliveredAt: new Date() } }
    );
  }

  return { delivered: pending.length };
}
