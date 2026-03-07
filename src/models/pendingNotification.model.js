import mongoose from "mongoose";

/**
 * PendingNotification
 * Stores notifications that must be delivered when a user reconnects.
 *
 * Requirement schema:
 * {
 *   userId,
 *   type: "MESSAGE",
 *   fromUserId,
 *   conversationId,
 *   previewText,
 *   isDelivered: false,
 *   createdAt
 * }
 */

const pendingNotificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: ["MESSAGE"], required: true },
    fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },
    previewText: { type: String, default: "" },
    isDelivered: { type: Boolean, default: false, index: true },
    deliveredAt: { type: Date, default: null },
  },
  { timestamps: true }
);

pendingNotificationSchema.index({ userId: 1, isDelivered: 1, createdAt: 1 });

export default mongoose.model("PendingNotification", pendingNotificationSchema);
