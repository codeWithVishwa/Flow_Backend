import mongoose from "mongoose";

const adminAuditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    actorName: { type: String, default: null },
    actorEmail: { type: String, default: null },
    role: { type: String, default: "admin" },
    action: { type: String, required: true },
    targetType: { type: String, default: null },
    targetId: { type: String, default: null },
    targetName: { type: String, default: null },
    targetEmail: { type: String, default: null },
    notes: { type: String, default: "" },
    reason: { type: String, default: "" },
  },
  { timestamps: true },
);

adminAuditLogSchema.index({ createdAt: -1 });
adminAuditLogSchema.index({ actorId: 1, createdAt: -1 });
adminAuditLogSchema.index({ action: 1, createdAt: -1 });

export default mongoose.model("AdminAuditLog", adminAuditLogSchema);
