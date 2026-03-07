import mongoose from "mongoose";

const conversationSchema = new mongoose.Schema(
  {
    participants: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }],
      validate: {
        validator: function (value) {
          if (!Array.isArray(value)) return false;
          const inferredGroup =
            this.isGroup === true ||
            (this.isGroup == null &&
              (!!this.name ||
                !!this.inviteCode ||
                (Array.isArray(this.admins) && this.admins.length > 0)));
          if (inferredGroup) return value.length >= 1;
          return value.length === 2;
        },
        message: function () {
          const inferredGroup =
            this.isGroup === true ||
            (this.isGroup == null &&
              (!!this.name ||
                !!this.inviteCode ||
                (Array.isArray(this.admins) && this.admins.length > 0)));
          return inferredGroup
            ? "Group conversations must have at least one participant"
            : "Direct conversations require exactly two participants";
        },
      },
    },
    isGroup: { type: Boolean, default: false },
    name: { type: String, default: null },
    photoUrl: { type: String, default: null },
    admins: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    inviteCode: { type: String, trim: true, default: undefined },
    inviteEnabled: { type: Boolean, default: true },
    directPairKey: { type: String, default: undefined },
    sessionKeyVersion: { type: Number, default: 1 },
    lastMessage: {
      type: {
        text: { type: String },
        msgType: { type: String }, // 'text', 'image', 'video', 'audio', 'post'
        ciphertextPreview: { type: String }, // Legacy field
        sender: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        at: { type: Date },
      },
    },
    favorites: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    clearedFor: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        clearedAt: { type: Date, required: true },
      }
    ],
  },
  { timestamps: true }
);

conversationSchema.pre("validate", function (next) {
  if (!this.isGroup && Array.isArray(this.participants) && this.participants.length === 2) {
    this.directPairKey = this.participants
      .map((id) => id.toString())
      .sort()
      .join(":");
  } else {
    // Keep undefined for group chats so unique index does not consider this field.
    this.directPairKey = undefined;
  }
  next();
});

conversationSchema.index({ participants: 1 });
conversationSchema.index(
  { inviteCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      inviteCode: { $exists: true, $type: "string", $ne: "" },
    },
  }
);
conversationSchema.index(
  { directPairKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      directPairKey: { $exists: true, $type: "string", $ne: "" },
    },
  }
);
conversationSchema.index({ updatedAt: -1 });

export default mongoose.model("Conversation", conversationSchema);
