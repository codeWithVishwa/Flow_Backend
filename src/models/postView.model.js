import mongoose from "mongoose";

const postViewSchema = new mongoose.Schema(
  {
    post: { type: mongoose.Schema.Types.ObjectId, ref: "Post", required: true, index: true },
    viewer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    lastViewedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

postViewSchema.index({ post: 1, viewer: 1 }, { unique: true });

export default mongoose.model("PostView", postViewSchema);

