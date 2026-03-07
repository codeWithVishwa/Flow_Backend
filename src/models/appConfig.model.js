import mongoose from "mongoose";

const appConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, default: {} },
    description: { type: String, default: null },
  },
  { timestamps: true },
);

export default mongoose.model("AppConfig", appConfigSchema);
