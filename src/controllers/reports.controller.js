import Report from "../models/report.model.js";
import Post from "../models/post.model.js";
import User from "../models/user.model.js";

export const reportPost = async (req, res) => {
  try {
    const { postId } = req.params;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 200) : "inappropriate";

    const post = await Post.findById(postId).select("_id");
    if (!post) return res.status(404).json({ message: "Post not found" });

    const report = await Report.create({
      reporter: req.user._id,
      targetType: "post",
      post: post._id,
      reason: reason || "inappropriate",
      status: "open",
    });

    return res.status(201).json({ reportId: report._id, status: report.status });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Could not submit report" });
  }
};

export const reportUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 200) : "inappropriate";

    if (String(userId) === String(req.user._id)) {
      return res.status(400).json({ message: "You cannot report yourself" });
    }

    const target = await User.findById(userId).select("_id");
    if (!target) return res.status(404).json({ message: "User not found" });

    const report = await Report.create({
      reporter: req.user._id,
      targetType: "user",
      reportedUser: target._id,
      reason: reason || "inappropriate",
      status: "open",
    });

    return res.status(201).json({ reportId: report._id, status: report.status });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Could not submit report" });
  }
};
