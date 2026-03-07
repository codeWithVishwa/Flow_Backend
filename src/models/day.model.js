import mongoose from "mongoose";

const daySchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    media: {
      url: { type: String, required: true },
      type: { type: String, enum: ["image", "video"], required: true },
      publicId: { type: String }, // for cloudinary
      durationSeconds: { type: Number },
    },
    viewers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Index to automatically delete expired documents
daySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Day = mongoose.model("Day", daySchema);
export default Day;
