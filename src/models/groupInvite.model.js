import mongoose from "mongoose";

const groupInviteSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    inviter: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    invitee: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: ["pending", "accepted", "declined"], default: "pending", index: true },
  },
  { timestamps: true }
);

groupInviteSchema.index({ conversation: 1, invitee: 1, status: 1 }, { unique: true, partialFilterExpression: { status: "pending" } });

groupInviteSchema.index({ invitee: 1, createdAt: -1 });

groupInviteSchema.index({ conversation: 1, createdAt: -1 });

export default mongoose.model("GroupInvite", groupInviteSchema);
