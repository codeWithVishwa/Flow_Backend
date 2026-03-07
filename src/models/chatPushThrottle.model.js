import mongoose from "mongoose";

/**
 * ChatPushThrottle
 * Prevents push notification spam by throttling chat pushes per:
 * (userId, fromUserId, conversationId)
 */
const chatPushThrottleSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },

    lastSentAt: { type: Date, default: null },
    lastEventAt: { type: Date, default: null },
    lastPreviewText: { type: String, default: "" },
    suppressedCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

chatPushThrottleSchema.index(
  { userId: 1, fromUserId: 1, conversationId: 1 },
  { unique: true }
);

export default mongoose.model("ChatPushThrottle", chatPushThrottleSchema);
