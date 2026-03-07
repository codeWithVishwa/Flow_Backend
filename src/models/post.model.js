import mongoose from "mongoose";

const mediaSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    secureUrl: { type: String },
    type: { type: String, enum: ["image", "video"], required: true },
    publicId: { type: String },
    assetId: { type: String },
    format: { type: String },
    bytes: { type: Number },
    thumbnailUrl: { type: String },
    width: { type: Number },
    height: { type: Number },
    durationSeconds: { type: Number },
    isDelete:{type:Boolean,default:false}
  },
  { _id: false }
);

const postSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    caption: { type: String, trim: true, maxlength: 500 },
    tags: { type: [String], default: [] },
    isAdult: { type: Boolean, default: false },
    media: { type: [mediaSchema], default: [] },
    visibility: { type: String, enum: ["public", "private"], default: "public" },
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    viewCount: { type: Number, default: 0 },
    playCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
    hideLikeCount: { type: Boolean, default: false },
    commentsDisabled: { type: Boolean, default: false },
    isDelete:{type:Boolean,default:false}
  },
  { timestamps: true }
);

postSchema.index({ author: 1, createdAt: -1 });
postSchema.index({ createdAt: -1 });
postSchema.index({ tags: 1, createdAt: -1 });
postSchema.index({ caption: "text", tags: "text" });

export default mongoose.model("Post", postSchema);
