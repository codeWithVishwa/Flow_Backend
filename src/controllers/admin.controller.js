import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import User from "../models/user.model.js";
import Post from "../models/post.model.js";
import Comment from "../models/comment.model.js";
import Report from "../models/report.model.js";
import AppConfig from "../models/appConfig.model.js";
import AdminAuditLog from "../models/adminAuditLog.model.js";
import AdminNotification from "../models/adminNotification.model.js";

const CLIENT_CONFIG_KEY = "client_config_v1";

const DEFAULT_CLIENT_CONFIG = {
  featureFlags: {
    premiumUploadUI: true,
    enableNearbyUsersTab: true,
    enableTypingIndicator: true,
    enablePostRecommendations: true,
    enableClipRecommendations: true,
    enableCreatorInsights: true,
  },
  upload: {
    maxVideoSeconds: 20,
    maxVideoMegabytes: 20,
    allowedVideoFormats: ["mp4"],
  },
  feed: {
    suggestedProfilesCadence: [2, 30],
  },
};

function mergeClientConfig(raw) {
  return {
    ...DEFAULT_CLIENT_CONFIG,
    ...(raw && typeof raw === "object" ? raw : {}),
    featureFlags: {
      ...DEFAULT_CLIENT_CONFIG.featureFlags,
      ...(raw?.featureFlags || {}),
    },
  };
}

function signAdminToken(userId) {
  return jwt.sign({ id: userId, typ: "admin" }, process.env.JWT_SECRET, { expiresIn: "12h" });
}

function toSessionId(tokenHash) {
  if (!tokenHash) return null;
  return crypto.createHash("sha256").update(String(tokenHash)).digest("hex").slice(0, 24);
}

async function writeAudit(req, payload) {
  try {
    await AdminAuditLog.create({
      actorId: req.user?._id,
      actorName: req.user?.name || null,
      actorEmail: req.user?.email || null,
      role: req.user?.role || "admin",
      ...payload,
    });
  } catch {
    // no-op
  }
}

export const adminLogin = async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

    const user = await User.findOne({ email }).select("_id name email role status password");
    if (!user) return res.status(404).json({ error: "Admin user not found" });
    if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    if (user.status !== "active") return res.status(403).json({ error: "Account is not active" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: "Invalid credentials" });

    const token = signAdminToken(user._id);
    res.json({
      token,
      user: { _id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Login failed" });
  }
};

export const adminMe = async (req, res) => {
  res.json({
    _id: req.user._id,
    name: req.user.name,
    email: req.user.email,
    role: req.user.role,
  });
};

export const adminLogout = async (_req, res) => {
  res.json({ success: true });
};

export const getStats = async (_req, res) => {
  try {
    const [users, posts, postsDeleted, reportsOpen, reportsTotal] = await Promise.all([
      User.countDocuments({ isDeleted: { $ne: true } }),
      Post.countDocuments({}),
      Post.countDocuments({ $or: [{ isDelete: true }, { isDeleted: true }] }),
      Report.countDocuments({ status: "open" }),
      Report.countDocuments({}),
    ]);
    res.json({ users, posts, postsDeleted, reportsOpen, reportsTotal });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to load stats" });
  }
};

export const getAllUsers = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const filter = {};
    if (q) {
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: regex }, { email: regex }];
    }

    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter, "_id name email status role isVerified verificationType verifiedBy verifiedAt lastIp lastActiveAt lastLoginAt avatarUrl createdAt")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
    ]);

    res.json({
      items: users,
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to load users" });
  }
};

export const getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id, "_id name email status role isVerified verificationType verifiedBy verifiedAt lastIp lastActiveAt lastLoginAt avatarUrl createdAt");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to load user" });
  }
};

export const banUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.status = "banned";
    await user.save();
    await writeAudit(req, { action: "ban user", targetType: "user", targetId: String(user._id), targetName: user.name, targetEmail: user.email, reason: String(req.body?.reason || "") });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to ban user" });
  }
};

export const suspendUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.status = "suspended";
    await user.save();
    await writeAudit(req, { action: "suspend user", targetType: "user", targetId: String(user._id), targetName: user.name, targetEmail: user.email, reason: String(req.body?.reason || "") });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to suspend user" });
  }
};

export const unbanUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.status = "active";
    await user.save();
    await writeAudit(req, { action: "unban user", targetType: "user", targetId: String(user._id), targetName: user.name, targetEmail: user.email, reason: String(req.body?.reason || "") });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to unban user" });
  }
};

export const verifyUser = async (req, res) => {
  try {
    const { userId, verificationType, reason } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId is required" });
    if (!["official", "creator", "developer"].includes(String(verificationType))) {
      return res.status(400).json({ error: "Invalid verificationType" });
    }
    if (!String(reason || "").trim()) return res.status(400).json({ error: "Reason is required" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.isVerified = true;
    user.verificationType = String(verificationType);
    user.verifiedBy = req.user._id;
    user.verifiedAt = new Date();
    await user.save();

    await writeAudit(req, { action: "verify user", targetType: "user", targetId: String(user._id), targetName: user.name, targetEmail: user.email, reason: String(reason || "") });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Verification failed" });
  }
};

export const revokeVerification = async (req, res) => {
  try {
    const { userId, reason } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId is required" });
    if (!String(reason || "").trim()) return res.status(400).json({ error: "Reason is required" });
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.isVerified = false;
    user.verificationType = null;
    user.verifiedBy = null;
    user.verifiedAt = null;
    await user.save();
    await writeAudit(req, { action: "revoke verification", targetType: "user", targetId: String(user._id), targetName: user.name, targetEmail: user.email, reason: String(reason || "") });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Revoke failed" });
  }
};

export const getUserSessions = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("_id name email refreshTokens");
    if (!user) return res.status(404).json({ error: "User not found" });
    const now = new Date();
    const sessions = (Array.isArray(user.refreshTokens) ? user.refreshTokens : [])
      .filter((token) => !token?.expiresAt || token.expiresAt >= now)
      .map((token) => ({
        sessionId: toSessionId(token.tokenHash),
        createdAt: token.createdAt || null,
        lastUsedAt: token.lastUsedAt || token.createdAt || null,
        expiresAt: token.expiresAt || null,
        deviceName: token.deviceName || null,
        deviceId: token.deviceId || null,
        userAgent: token.userAgent || null,
        ip: token.ip || null,
      }))
      .sort((a, b) => new Date(b.lastUsedAt || 0) - new Date(a.lastUsedAt || 0));
    res.json({ user: { _id: user._id, name: user.name, email: user.email }, sessions });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to load sessions" });
  }
};

export const revokeUserSession = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    const sessions = Array.isArray(user.refreshTokens) ? user.refreshTokens : [];
    const target = sessions.find((token) => toSessionId(token.tokenHash) === String(req.params.sessionId));
    if (!target) return res.status(404).json({ error: "Session not found" });
    user.refreshTokens = sessions.filter((token) => token.tokenHash !== target.tokenHash);
    await user.save();
    await writeAudit(req, { action: "revoke user session", targetType: "user", targetId: String(user._id), targetName: user.name, targetEmail: user.email, notes: `session=${req.params.sessionId}` });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to revoke session" });
  }
};

export const revokeAllUserSessions = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found" });
    const count = Array.isArray(user.refreshTokens) ? user.refreshTokens.length : 0;
    user.refreshTokens = [];
    await user.save();
    await writeAudit(req, { action: "revoke all user sessions", targetType: "user", targetId: String(user._id), targetName: user.name, targetEmail: user.email, notes: `revoked=${count}` });
    res.json({ success: true, revoked: count });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to revoke sessions" });
  }
};

export const getAllPosts = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const authorId = String(req.query.authorId || "").trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const skip = (page - 1) * limit;
    const filter = {};
    if (authorId) filter.author = authorId;
    if (q) {
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ caption: regex }];
    }
    const [total, items] = await Promise.all([
      Post.countDocuments(filter),
      Post.find(filter).populate("author", "_id name email").sort({ createdAt: -1 }).skip(skip).limit(limit),
    ]);
    res.json({ items, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to load posts" });
  }
};

export const getPostById = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).populate("author", "_id name email");
    if (!post) return res.status(404).json({ error: "Post not found" });
    res.json(post);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to load post" });
  }
};

export const getCommentsForPost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).select("_id");
    if (!post) return res.status(404).json({ error: "Post not found" });
    const comments = await Comment.find({ post: post._id }).populate("author", "_id name email avatarUrl").sort({ createdAt: -1 });
    res.json(comments);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to load comments" });
  }
};

export const deleteComment = async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.id).populate("author", "_id name email");
    if (!comment) return res.status(404).json({ error: "Comment not found" });
    await comment.deleteOne();
    await writeAudit(req, { action: "delete comment", targetType: "comment", targetId: String(comment._id), targetName: comment.author?.name || null, targetEmail: comment.author?.email || null });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to delete comment" });
  }
};

export const softDeletePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).populate("author", "_id name email");
    if (!post) return res.status(404).json({ error: "Post not found" });
    post.isDelete = true;
    post.isDeleted = true;
    await post.save();
    await writeAudit(req, { action: "soft delete post", targetType: "post", targetId: String(post._id), targetName: post.author?.name || null, targetEmail: post.author?.email || null, notes: String(req.body?.notes || "") });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to soft delete post" });
  }
};

export const deletePost = async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).populate("author", "_id name email");
    if (!post) return res.status(404).json({ error: "Post not found" });
    await post.deleteOne();
    await Comment.deleteMany({ post: post._id }).catch(() => {});
    await writeAudit(req, { action: "delete post", targetType: "post", targetId: String(post._id), targetName: post.author?.name || null, targetEmail: post.author?.email || null, notes: String(req.body?.notes || "") });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to delete post" });
  }
};

export const getAllReports = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const skip = (page - 1) * limit;
    const targetType = String(req.query.targetType || "").trim();
    const filter = {};
    if (["post", "user"].includes(targetType)) filter.targetType = targetType;

    const [total, reports] = await Promise.all([
      Report.countDocuments(filter),
      Report.find(filter)
        .populate("reporter", "_id name email")
        .populate("reportedUser", "_id name email")
        .populate({ path: "post", populate: { path: "author", select: "_id name email" } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
    ]);

    const items = reports.map((r) => ({
      _id: r._id,
      targetType: r.targetType || "post",
      reporterName: r.reporter?.name || null,
      reporterEmail: r.reporter?.email || null,
      reportedUserId: r.reportedUser?._id || null,
      reportedUserName: r.reportedUser?.name || null,
      reportedUserEmail: r.reportedUser?.email || null,
      postId: r.post?._id || null,
      postCaption: r.post?.caption ? String(r.post.caption).slice(0, 140) : null,
      postAuthorName: r.post?.author?.name || null,
      postAuthorEmail: r.post?.author?.email || null,
      postDeleted: r.post ? Boolean(r.post.isDelete || r.post.isDeleted) : null,
      postMediaCount: Array.isArray(r.post?.media) ? r.post.media.length : 0,
      reason: r.reason,
      status: r.status,
      flagged: !!r.flagged,
      notesCount: Array.isArray(r.adminNotes) ? r.adminNotes.length : 0,
      lastNotePreview: Array.isArray(r.adminNotes) && r.adminNotes.length ? String(r.adminNotes[r.adminNotes.length - 1].note || "").slice(0, 80) : null,
      createdAt: r.createdAt || null,
    }));

    res.json({ items, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to load reports" });
  }
};

export const getLatestReport = async (req, res) => {
  try {
    const targetType = String(req.query.targetType || "").trim();
    const filter = { status: "open" };
    if (["post", "user"].includes(targetType)) filter.targetType = targetType;
    const r = await Report.findOne(filter)
      .populate("reporter", "_id name email")
      .populate("reportedUser", "_id name email")
      .populate({ path: "post", populate: { path: "author", select: "_id name email" } })
      .sort({ createdAt: -1 });
    if (!r) return res.json({ report: null });
    res.json({
      report: {
        _id: r._id,
        targetType: r.targetType || "post",
        reporterName: r.reporter?.name || null,
        reporterEmail: r.reporter?.email || null,
        reportedUserId: r.reportedUser?._id || null,
        reportedUserName: r.reportedUser?.name || null,
        reportedUserEmail: r.reportedUser?.email || null,
        postId: r.post?._id || null,
        postCaption: r.post?.caption || null,
        postAuthorName: r.post?.author?.name || null,
        postAuthorEmail: r.post?.author?.email || null,
        postDeleted: r.post ? Boolean(r.post.isDelete || r.post.isDeleted) : null,
        reason: r.reason,
        status: r.status,
        flagged: !!r.flagged,
        createdAt: r.createdAt || null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to load latest report" });
  }
};

export const getReportById = async (req, res) => {
  try {
    const r = await Report.findById(req.params.id)
      .populate("reporter", "_id name email")
      .populate("reportedUser", "_id name email")
      .populate({ path: "post", populate: { path: "author", select: "_id name email" } });
    if (!r) return res.status(404).json({ error: "Report not found" });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to load report" });
  }
};

export const setReportFlag = async (req, res) => {
  try {
    const r = await Report.findById(req.params.id);
    if (!r) return res.status(404).json({ error: "Report not found" });
    const next = typeof req.body?.flagged === "boolean" ? req.body.flagged : !r.flagged;
    r.flagged = next;
    r.flaggedAt = next ? new Date() : null;
    r.flaggedById = next ? req.user._id : null;
    r.flaggedByName = next ? req.user.name : null;
    r.flaggedByEmail = next ? req.user.email : null;
    await r.save();
    await writeAudit(req, { action: next ? "flag report" : "unflag report", targetType: "report", targetId: String(r._id) });
    res.json({ success: true, flagged: r.flagged });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to set flag" });
  }
};

export const addReportNote = async (req, res) => {
  try {
    const note = String(req.body?.note || "").trim();
    if (!note) return res.status(400).json({ error: "Note is required" });
    const r = await Report.findById(req.params.id);
    if (!r) return res.status(404).json({ error: "Report not found" });
    r.adminNotes = Array.isArray(r.adminNotes) ? r.adminNotes : [];
    r.adminNotes.push({
      byId: req.user._id,
      byName: req.user.name,
      byEmail: req.user.email,
      role: req.user.role,
      note,
      createdAt: new Date(),
    });
    await r.save();
    await writeAudit(req, { action: "add report note", targetType: "report", targetId: String(r._id), notes: note.slice(0, 500) });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to add note" });
  }
};

export const resolveReport = async (req, res) => {
  try {
    const r = await Report.findById(req.params.id);
    if (!r) return res.status(404).json({ error: "Report not found" });
    r.status = "resolved";
    await r.save();
    await writeAudit(req, { action: "resolve report", targetType: "report", targetId: String(r._id), notes: String(req.body?.notes || "") });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to resolve report" });
  }
};

export const getClientConfig = async (_req, res) => {
  try {
    const doc = await AppConfig.findOne({ key: CLIENT_CONFIG_KEY }).lean();
    const config = mergeClientConfig(doc?.value || {});
    res.json({ config, updatedAt: doc?.updatedAt || null });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to load config" });
  }
};

export const updateClientConfig = async (req, res) => {
  try {
    const payload = req.body?.config;
    if (!payload || typeof payload !== "object") return res.status(400).json({ error: "config object is required" });
    const config = mergeClientConfig(payload);
    const doc = await AppConfig.findOneAndUpdate(
      { key: CLIENT_CONFIG_KEY },
      { key: CLIENT_CONFIG_KEY, value: config, description: "Client feature flags" },
      { upsert: true, new: true },
    );
    await writeAudit(req, { action: "update client config", targetType: "system", targetId: String(doc._id) });
    res.json({ success: true, config, updatedAt: doc.updatedAt });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to update config" });
  }
};

export const getCreatorLeaderboard = async (req, res) => {
  try {
    const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 30, 365));
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const items = await Post.aggregate([
      { $match: { createdAt: { $gte: since }, isDelete: { $ne: true }, isDeleted: { $ne: true } } },
      {
        $project: {
          author: 1,
          likesCount: { $size: { $ifNull: ["$likes", []] } },
          commentCount: { $ifNull: ["$commentCount", 0] },
          viewCount: { $max: [{ $ifNull: ["$viewCount", 0] }, { $ifNull: ["$playCount", 0] }] },
          createdAt: 1,
        },
      },
      {
        $group: {
          _id: "$author",
          posts: { $sum: 1 },
          likes: { $sum: "$likesCount" },
          comments: { $sum: "$commentCount" },
          views: { $sum: "$viewCount" },
          lastPostAt: { $max: "$createdAt" },
        },
      },
      { $addFields: { score: { $add: [{ $multiply: ["$likes", 2] }, { $multiply: ["$comments", 2] }, { $multiply: ["$views", 0.2] }, { $multiply: ["$posts", 1.5] }] } } },
      { $sort: { score: -1, views: -1, likes: -1, lastPostAt: -1 } },
      { $limit: limit },
      { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user" } },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          name: "$user.name",
          email: "$user.email",
          avatarUrl: "$user.avatarUrl",
          status: "$user.status",
          posts: 1,
          likes: 1,
          comments: 1,
          views: 1,
          score: { $round: ["$score", 2] },
          lastPostAt: 1,
        },
      },
    ]);
    res.json({ days, limit, items });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to load creator leaderboard" });
  }
};

export const getCreatorInsights = async (req, res) => {
  try {
    const { userId } = req.params;
    const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 30, 365));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [user, posts] = await Promise.all([
      User.findById(userId).select("_id name email avatarUrl status"),
      Post.find({ author: userId, createdAt: { $gte: since }, isDelete: { $ne: true }, isDeleted: { $ne: true } }).select("_id likes commentCount viewCount playCount createdAt"),
    ]);
    if (!user) return res.status(404).json({ error: "User not found" });
    const totals = posts.reduce((acc, p) => {
      acc.posts += 1;
      acc.likes += Array.isArray(p.likes) ? p.likes.length : 0;
      acc.comments += Number(p.commentCount || 0);
      acc.views += Math.max(Number(p.viewCount || 0), Number(p.playCount || 0), 0);
      return acc;
    }, { posts: 0, likes: 0, comments: 0, views: 0 });
    const byDay = new Map();
    posts.forEach((p) => {
      const key = new Date(p.createdAt).toISOString().slice(0, 10);
      const row = byDay.get(key) || { date: key, posts: 0, likes: 0, comments: 0, views: 0 };
      row.posts += 1;
      row.likes += Array.isArray(p.likes) ? p.likes.length : 0;
      row.comments += Number(p.commentCount || 0);
      row.views += Math.max(Number(p.viewCount || 0), Number(p.playCount || 0), 0);
      byDay.set(key, row);
    });
    const daily = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));
    res.json({ user, days, totals, averageViewsPerPost: totals.posts > 0 ? Math.round(totals.views / totals.posts) : 0, daily });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to load creator insights" });
  }
};

export const getAdminNotifications = async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const items = await AdminNotification.find({}).sort({ createdAt: -1 }).limit(limit);
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to load notifications" });
  }
};

export const createAdminNotification = async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const message = String(req.body?.message || "").trim();
    const type = String(req.body?.type || "info").trim();
    if (!title || !message) return res.status(400).json({ error: "title and message are required" });
    const doc = await AdminNotification.create({
      title,
      message,
      type,
      createdBy: req.user._id,
      createdByName: req.user.name,
    });
    await writeAudit(req, { action: "create admin notification", targetType: "system", targetId: String(doc._id), notes: `${title}` });
    res.json({ success: true, notification: doc });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to create notification" });
  }
};

export const getAuditLogs = async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const logs = await AdminAuditLog.find({}).sort({ createdAt: -1 }).limit(limit);
    res.json(logs);
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to load audit logs" });
  }
};
