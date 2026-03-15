import mongoose from "mongoose";

const notificationEventSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    eventType: {
      type: String,
      enum: [
        "sent",
        "provider_accepted",
        "delivery_failed",
        "received",
        "opened",
        "action_clicked",
        "dismissed",
      ],
      required: true,
      index: true,
    },
    source: { type: String, default: "push" },
    notificationType: { type: String, default: null, index: true },
    provider: { type: String, default: null },
    actionIdentifier: { type: String, default: null },
    conversationId: { type: String, default: null },
    messageId: { type: String, default: null },
    tokenSuffix: { type: String, default: null },
    status: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

notificationEventSchema.index({ user: 1, createdAt: -1 });
notificationEventSchema.index({ eventType: 1, createdAt: -1 });
notificationEventSchema.index({ user: 1, eventType: 1, createdAt: -1 });

export default mongoose.model("NotificationEvent", notificationEventSchema);
