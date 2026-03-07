import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    text: { type: String, default: "" },
    type: {
      type: String,
      enum: ["text", "image", "video", "audio", "post", "profile", "call"],
      default: "text",
    },
    mediaUrl: { type: String, default: null },
    mediaDuration: { type: Number, default: null },
    post: { type: mongoose.Schema.Types.ObjectId, ref: "Post", default: null },
    sharedProfile: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: "Message", default: null },
    readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    deleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // Legacy encrypted fields (deprecated)
    ciphertext: { type: String, default: null },
    nonce: { type: String, default: null },
    payloadType: { type: String, default: null }, // Legacy field, use 'type' instead
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, createdAt: -1 });

export default mongoose.model("Message", messageSchema);
