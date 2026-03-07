import mongoose from "mongoose";

const adminNotificationSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 140 },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    type: { type: String, default: "info" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    createdByName: { type: String, default: null },
  },
  { timestamps: true },
);

adminNotificationSchema.index({ createdAt: -1 });

export default mongoose.model("AdminNotification", adminNotificationSchema);
