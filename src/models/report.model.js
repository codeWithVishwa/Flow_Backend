import mongoose from "mongoose";

const reportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    targetType: { type: String, enum: ["post", "user"], default: "post" },
    post: { type: mongoose.Schema.Types.ObjectId, ref: "Post", default: null },
    reportedUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reason: { type: String, default: "inappropriate" },
    status: { type: String, enum: ["open", "resolved"], default: "open" },
    flagged: { type: Boolean, default: false },
    flaggedAt: { type: Date, default: null },
    flaggedById: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    flaggedByName: { type: String, default: null },
    flaggedByEmail: { type: String, default: null },
    adminNotes: [
      {
        byId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        byName: { type: String, default: null },
        byEmail: { type: String, default: null },
        role: { type: String, default: "admin" },
        note: { type: String, required: true, trim: true, maxlength: 2000 },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model("Report", reportSchema);
