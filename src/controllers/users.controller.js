import mongoose from "mongoose";
import User from "../models/user.model.js";
import Post from "../models/post.model.js";
import Notification from "../models/notification.model.js";
import cloudinary from "cloudinary";
import sharp from "sharp";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { getIO } from "../socket.js";
import { suggestUsernames } from "../utils/nameSuggestions.js";
import { sendPushNotification } from "../utils/expoPush.js";
import { getOnlineUsers, getSocketIdsForUser } from "../socket.js";

// Lazy Cloudinary configuration so it works even if dotenv loads later
function ensureCloudinaryConfigured() {
  const cfg = cloudinary.v2.config();
  if (!cfg.api_key || !cfg.cloud_name) {
    cloudinary.v2.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }
}

function isCloudinaryConfigured() {
  const cfg = cloudinary.v2.config();
  return Boolean(cfg.cloud_name && cfg.api_key && cfg.api_secret);
}

const ACTIVE_VERIFIED_USER = { verified: true, status: 'active' };

async function countActiveVerifiedUsers(ids = []) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  return User.countDocuments({ _id: { $in: ids }, ...ACTIVE_VERIFIED_USER });
}

async function getBlockStatus(userId, otherId) {
  const [me, other] = await Promise.all([
    User.findById(userId).select('_id blockedUsers'),
    User.findById(otherId).select('_id name email avatarUrl blockedUsers'),
  ]);
  if (!other) return { notFound: true };
  const blockedByMe = Array.isArray(me?.blockedUsers) && me.blockedUsers.some((id) => String(id) === String(otherId));
  const blockedByOther = Array.isArray(other.blockedUsers) && other.blockedUsers.some((id) => String(id) === String(userId));
  return { blockedByMe, blockedByOther, other };
}

async function removeFriendshipBetween(a, b) {
  await Promise.all([
    User.findByIdAndUpdate(a, {
      $pull: { following: b, followers: b, followRequests: b },
    }),
    User.findByIdAndUpdate(b, {
      $pull: { following: a, followers: a, followRequests: a },
    }),
  ]);
}

function buildMutualFollowSet(viewer = null) {
  const following = new Set(Array.isArray(viewer?.following) ? viewer.following.map((id) => String(id)) : []);
  const followers = new Set(Array.isArray(viewer?.followers) ? viewer.followers.map((id) => String(id)) : []);
  return new Set(Array.from(following).filter((id) => followers.has(id)));
}

async function buildFriendRecommendations(userId) {
  const me = await User.findById(userId).select("_id interests following followers");
  if (!me) return [];
  const myInterests = Array.isArray(me.interests) ? me.interests.filter(Boolean) : [];

  // Find users I have requested to follow (for private accounts)
  const requestedUsers = await User.find({ followRequests: userId }).select("_id");
  
  const exclude = new Set([String(userId)]);
  
  // Exclude people I already follow
  if (Array.isArray(me.following)) {
    me.following.forEach(id => exclude.add(String(id)));
  }

  // Exclude people I have requested to follow
  requestedUsers.forEach(u => exclude.add(String(u._id)));

  const viewerFriends = buildMutualFollowSet(me);
  const viewerFriendIds = Array.from(viewerFriends);

  const buildFallback = async () => {
    const fallbackUsers = await User.find({
      _id: { $nin: Array.from(exclude) },
      ...ACTIVE_VERIFIED_USER,
    })
      .select("_id name avatarUrl interests following")
      .sort({ createdAt: -1 })
      .limit(15);
    return fallbackUsers.map((user) => ({
      _id: user._id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      interests: user.interests,
      overlap: 0,
      mutualFriendCount: 0,
      mutualsPreview: [],
    }));
  };

  if (!myInterests.length) return buildFallback();

  const candidates = await User.find({
    _id: { $nin: Array.from(exclude) },
    ...ACTIVE_VERIFIED_USER,
    interests: { $in: myInterests },
  })
    .select("_id name avatarUrl interests following")
    .limit(75);

  if (!candidates.length) return buildFallback();

  const mySet = new Set(myInterests);
  const previewIdSet = new Set();
  const candidateRows = candidates.map((user) => {
    const overlap = (user.interests || []).reduce((acc, val) => acc + (mySet.has(val) ? 1 : 0), 0);
    const candidateFollowing = new Set(Array.isArray(user.following) ? user.following.map((id) => String(id)) : []);
    const mutualIds = viewerFriendIds.filter((id) => candidateFollowing.has(id));
    mutualIds.slice(0, 3).forEach((id) => previewIdSet.add(id));
    return {
      _id: user._id,
      name: user.name,
      avatarUrl: user.avatarUrl,
      interests: user.interests,
      overlap,
      mutualFriendCount: mutualIds.length,
      mutualPreviewIds: mutualIds.slice(0, 3),
    };
  });

  const previewUsers = previewIdSet.size
    ? await User.find({ _id: { $in: Array.from(previewIdSet) }, ...ACTIVE_VERIFIED_USER })
        .select("_id name avatarUrl")
    : [];
  const previewMap = new Map(
    previewUsers.map((user) => [
      String(user._id),
      {
        _id: user._id,
        name: user.name,
        avatarUrl: user.avatarUrl,
      },
    ])
  );

  return candidateRows
    .map((entry) => ({
      ...entry,
      mutualsPreview: entry.mutualPreviewIds.map((id) => previewMap.get(String(id))).filter(Boolean),
    }))
    .filter((entry) => entry.overlap > 0 || entry.mutualFriendCount > 0)
    .sort(
      (a, b) =>
        b.mutualFriendCount - a.mutualFriendCount ||
        b.overlap - a.overlap ||
        a.name.localeCompare(b.name)
    )
    .map(({ mutualPreviewIds, ...entry }) => entry)
    .slice(0, 15);
}

function serializeNotification(notification) {
  return {
    _id: notification._id,
    type: notification.type,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
    metadata: notification.metadata || {},
    actor: notification.actor
      ? {
          _id: notification.actor._id,
          name: notification.actor.name,
          avatarUrl: notification.actor.avatarUrl,
        }
      : null,
  };
}

function toAbsoluteUrl(url) {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = process.env.APP_BASE_URL || process.env.BASE_URL;
  if (!base) return url;
  return `${String(base).replace(/\/$/, "")}/${url.replace(/^\//, "")}`;
}

async function viewerCanSeePost(userId, postId) {
  if (!postId) return false;
  const post = await Post.findById(postId).select("author visibility isDelete isDeleted");
  if (!post) return false;
  if (post.isDelete || post.isDeleted) return false;
  const authorId = post.author && post.author._id ? post.author._id : post.author;
  if (String(authorId) === String(userId)) return true;
  if (post.visibility === "public") return true;
  const followsAuthor = await User.exists({ _id: authorId, followers: userId });
  return Boolean(followsAuthor);
}

async function filterNotificationsForViewer(userId, notifications) {
  const cache = new Map();
  const filtered = [];
  for (const notification of notifications) {
    if (notification.type === "comment_mention") {
      const postId = notification.metadata?.postId;
      if (!postId) {
        await Notification.deleteOne({ _id: notification._id }).catch(() => {});
        continue;
      }
      if (!cache.has(postId)) {
        cache.set(postId, viewerCanSeePost(userId, postId));
      }
      const allowed = await cache.get(postId);
      if (!allowed) {
        await Notification.deleteOne({ _id: notification._id }).catch(() => {});
        continue;
      }
    }
    filtered.push(notification);
  }
  return filtered;
}

// Get users that current user can chat with (mutual follows or followers/following)
export const getChateableUsers = async (req, res) => {
  try {
    const userId = req.user._id;
    const q = (req.query.q || "").trim().toLowerCase();
    
    // Get current user's followers and following
    const currentUser = await User.findById(userId).select('followers following blockedUsers');
    if (!currentUser) return res.status(404).json({ message: "User not found" });
    
    // Combine followers and following into unique set
    const followerIds = (currentUser.followers || []).map(id => String(id));
    const followingIds = (currentUser.following || []).map(id => String(id));
    const blockedIds = (currentUser.blockedUsers || []).map(id => String(id));
    
    // Unique IDs from both lists, excluding blocked users
    const chateableIds = [...new Set([...followerIds, ...followingIds])]
      .filter(id => !blockedIds.includes(id));
    
    if (chateableIds.length === 0) {
      return res.json({ users: [] });
    }
    
    // Fetch user details
    let users = await User.find({
      _id: { $in: chateableIds },
      ...ACTIVE_VERIFIED_USER,
    }).select('_id name nickname avatarUrl isPrivate isVerified verificationType').lean();
    
    // Filter by search query if provided
    if (q) {
      users = users.filter(u => {
        const display = (u.nickname || u.name || '').toLowerCase();
        return display.includes(q);
      });
    }
    
    // Add relationship info
    const usersWithRelation = users.map(u => ({
      ...u,
      isFollowing: followingIds.includes(String(u._id)),
      isFollower: followerIds.includes(String(u._id)),
    }));
    
    // Sort: mutual follows first, then by name
    usersWithRelation.sort((a, b) => {
      const aMutual = a.isFollowing && a.isFollower;
      const bMutual = b.isFollowing && b.isFollower;
      if (aMutual && !bMutual) return -1;
      if (!aMutual && bMutual) return 1;
      const aName = (a.nickname || a.name || '').toLowerCase();
      const bName = (b.nickname || b.name || '').toLowerCase();
      return aName.localeCompare(bName);
    });
    
    res.json({ users: usersWithRelation });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const searchUsers = async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json({ users: [] });
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const viewerId = req.user._id;

    const docs = await User.aggregate([
      {
        $match: {
          _id: { $ne: viewerId },
          verified: true,
          status: 'active',
          $or: [{ name: regex }, { nickname: regex }],
        },
      },
      {
        $project: {
          name: 1,
          nickname: 1,
          verified: 1,
          avatarUrl: 1,
          isPrivate: 1,
          followers: { $ifNull: ["$followers", []] },
          following: { $ifNull: ["$following", []] },
          followRequests: { $ifNull: ["$followRequests", []] },
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'followers',
          foreignField: '_id',
          as: 'followersDocs',
          pipeline: [
            { $match: { verified: true, status: 'active' } },
            { $project: { _id: 1 } },
          ],
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'following',
          foreignField: '_id',
          as: 'followingDocs',
          pipeline: [
            { $match: { verified: true, status: 'active' } },
            { $project: { _id: 1 } },
          ],
        },
      },
      {
        $project: {
          name: 1,
          nickname: 1,
          verified: 1,
          avatarUrl: 1,
          isPrivate: 1,
          followerCount: { $size: { $ifNull: ["$followersDocs", []] } },
          followingCount: { $size: { $ifNull: ["$followingDocs", []] } },
          viewerIsFollower: { $in: [viewerId, "$followers"] },
          viewerRequested: { $in: [viewerId, "$followRequests"] },
          targetFollowsViewer: { $in: [viewerId, "$following"] },
        },
      },
      { $limit: 20 },
    ]);
    const users = docs.map((doc) => {
      let followStatus = "not_following";
      if (doc.viewerIsFollower) followStatus = "following";
      else if (doc.viewerRequested) followStatus = "requested";
      else if (doc.targetFollowsViewer) followStatus = "follow_back";
      return {
        _id: doc._id,
        name: doc.name,
        nickname: doc.nickname,
        verified: doc.verified,
        avatarUrl: doc.avatarUrl,
        isPrivate: !!doc.isPrivate,
        followerCount: doc.followerCount || 0,
        followingCount: doc.followingCount || 0,
        followStatus,
      };
    });
    res.json({ users });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const listNotifications = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 40, 100);
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - sevenDaysMs);

    // Weekly cleanup (Instagram-style): remove notifications older than 7 days.
    // This keeps the feed lightweight and prevents very old items from reappearing.
    await Notification.deleteMany({
      user: req.user._id,
      $or: [
        { createdAt: { $lt: cutoff } },
        { type: "friend_request" },
      ],
    }).catch(() => {});

    const [notifications, recommendations] = await Promise.all([
      Notification.find({ user: req.user._id, createdAt: { $gte: cutoff } })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate('actor', '_id name avatarUrl'),
      buildFriendRecommendations(req.user._id),
    ]);
    const safeNotifications = await filterNotificationsForViewer(req.user._id, notifications);
    res.json({
      notifications: safeNotifications.map(serializeNotification),
      recommendations,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const markAllNotificationsRead = async (req, res) => {
  try {
    const now = new Date();
    const result = await Notification.updateMany(
      { user: req.user._id, readAt: null },
      { $set: { readAt: now } }
    );
    res.json({ ok: true, modified: result?.modifiedCount ?? 0, readAt: now });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const listContacts = async (req, res) => {
  try {
    const me = await User.findById(req.user._id).select("followers following");
    if (!me) return res.status(404).json({ message: "User not found" });
    const followers = new Set(Array.isArray(me.followers) ? me.followers.map((id) => String(id)) : []);
    const following = new Set(Array.isArray(me.following) ? me.following.map((id) => String(id)) : []);
    const ids = Array.from(following).filter((id) => followers.has(id));
    const users = await User.find({ _id: { $in: ids } }).select("_id name email avatarUrl isVerified verificationType");
    res.json({ contacts: users });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("_id name nickname email avatarUrl gender interests bio verified isVerified verificationType honorScore profileLikes isPrivate followers following allowGroupAdds allowLocationDiscovery");
    if (!user) return res.status(404).json({ message: 'User not found' });
    const profileLikeCount = Array.isArray(user.profileLikes) ? user.profileLikes.length : 0;
    const [postCount, followerCount, followingCount] = await Promise.all([
      Post.countDocuments({
        author: user._id,
        isDelete: { $ne: true },
        isDeleted: { $ne: true },
      }),
      countActiveVerifiedUsers(user.followers),
      countActiveVerifiedUsers(user.following),
    ]);
    res.json({ user: {
      _id: user._id,
      name: user.name,
      nickname: user.nickname,
      email: user.email,
      avatarUrl: user.avatarUrl,
      gender: user.gender,
      interests: user.interests,
      bio: user.bio,
      verified: user.verified,
      isVerified: !!user.isVerified,
      verificationType: user.verificationType || null,
      honorScore: user.honorScore,
      profileLikeCount,
      followerCount,
      followingCount,
      isPrivate: !!user.isPrivate,
      allowGroupAdds: user.allowGroupAdds !== false,
      allowLocationDiscovery: user.allowLocationDiscovery !== false,
      postCount,
    } });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

export const updateProfile = async (req, res) => {
  try {
    const { name, nickname, interests, bio, gender } = req.body;
    const isPrivateProvided = Object.prototype.hasOwnProperty.call(req.body, 'isPrivate');
    const allowGroupAddsProvided = Object.prototype.hasOwnProperty.call(req.body, 'allowGroupAdds');
    const allowLocationProvided = Object.prototype.hasOwnProperty.call(req.body, 'allowLocationDiscovery');
    let nextPrivate;
    let nextAllowGroupAdds;
    let nextAllowLocation;
    if (isPrivateProvided) {
      const value = req.body.isPrivate;
      if (typeof value === 'string') {
        nextPrivate = value === 'true' || value === '1';
      } else {
        nextPrivate = !!value;
      }
    }
    if (allowGroupAddsProvided) {
      const value = req.body.allowGroupAdds;
      if (typeof value === 'string') {
        nextAllowGroupAdds = value === 'true' || value === '1';
      } else {
        nextAllowGroupAdds = !!value;
      }
    }
    if (allowLocationProvided) {
      const value = req.body.allowLocationDiscovery;
      if (typeof value === 'string') {
        nextAllowLocation = value === 'true' || value === '1';
      } else {
        nextAllowLocation = !!value;
      }
    }
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    if (normalizedName) {
      const existing = await User.findOne({ nameLower: normalizedName.toLowerCase(), _id: { $ne: user._id } }).select('_id');
      if (existing) {
        const suggestions = await suggestUsernames(normalizedName);
        return res.status(409).json({ message: 'Username already taken', suggestions });
      }
      user.name = normalizedName;
    }
    if (nickname !== undefined) {
      const nextNick = typeof nickname === 'string' ? nickname.trim() : '';
      user.nickname = nextNick ? nextNick.slice(0, 40) : null;
    }
    if (gender !== undefined) {
      const nextGender = typeof gender === 'string' ? gender.trim().toLowerCase() : '';
      user.gender = nextGender ? nextGender.slice(0, 32) : null;
    }
    if (Array.isArray(interests)) user.interests = interests.slice(0, 20);
    if (typeof bio === 'string') user.bio = bio.slice(0, 300);
    let visibilityChanged = false;
    if (isPrivateProvided && typeof nextPrivate === 'boolean' && user.isPrivate !== nextPrivate) {
      user.isPrivate = nextPrivate;
      visibilityChanged = true;
    }
    if (allowGroupAddsProvided && typeof nextAllowGroupAdds === 'boolean') {
      user.allowGroupAdds = nextAllowGroupAdds;
    }
    if (allowLocationProvided && typeof nextAllowLocation === 'boolean') {
      user.allowLocationDiscovery = nextAllowLocation;
      if (!nextAllowLocation) {
        user.location = undefined;
        user.locationUpdatedAt = null;
      } else if (user.location && !Array.isArray(user.location.coordinates)) {
        user.location = undefined;
        user.locationUpdatedAt = null;
      }
    }
    await user.save();
    if (visibilityChanged) {
      await Post.updateMany({ author: user._id }, { visibility: user.isPrivate ? 'private' : 'public' }).catch(() => {});
    }
    const postCount = await Post.countDocuments({
      author: user._id,
      isDelete: { $ne: true },
      isDeleted: { $ne: true },
    });
    res.json({
      user: {
        _id: user._id,
        name: user.name,
        nickname: user.nickname,
        email: user.email,
        avatarUrl: user.avatarUrl,
        gender: user.gender,
        interests: user.interests,
      bio: user.bio,
      isPrivate: !!user.isPrivate,
      allowGroupAdds: user.allowGroupAdds !== false,
      allowLocationDiscovery: user.allowLocationDiscovery !== false,
      postCount,
    }
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

export const updateMyLocation = async (req, res) => {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ message: "lat and lng are required" });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ message: "Invalid coordinates" });
    }
    const user = await User.findById(req.user._id).select("_id allowLocationDiscovery");
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.allowLocationDiscovery === false) {
      return res.status(403).json({ message: "Location discovery is disabled" });
    }
    user.location = { type: "Point", coordinates: [lng, lat] };
    user.locationUpdatedAt = new Date();
    await user.save();
    res.json({ ok: true, updatedAt: user.locationUpdatedAt });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const listNearbyUsers = async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radiusKm = Math.min(Number(req.query.radiusKm) || 25, 100);
    const limit = Math.min(Number(req.query.limit) || 30, 60);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ message: "lat and lng are required" });
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ message: "Invalid coordinates" });
    }
    const viewer = await User.findById(req.user._id).select("_id blockedUsers");
    if (!viewer) return res.status(404).json({ message: "User not found" });
    const viewerId = viewer._id;
    const blockedIds = Array.isArray(viewer.blockedUsers) ? viewer.blockedUsers : [];
    const docs = await User.aggregate([
      {
        $geoNear: {
          near: { type: "Point", coordinates: [lng, lat] },
          distanceField: "distanceMeters",
          maxDistance: radiusKm * 1000,
          spherical: true,
          query: {
            _id: { $ne: viewerId, $nin: blockedIds },
            verified: true,
            status: "active",
            allowLocationDiscovery: { $ne: false },
            blockedUsers: { $nin: [viewerId] },
          },
        },
      },
      {
        $project: {
          name: 1,
          nickname: 1,
          avatarUrl: 1,
          isPrivate: 1,
          location: 1,
          followers: { $ifNull: ["$followers", []] },
          following: { $ifNull: ["$following", []] },
          followRequests: { $ifNull: ["$followRequests", []] },
          distanceMeters: 1,
        },
      },
      {
        $project: {
          name: 1,
          nickname: 1,
          avatarUrl: 1,
          isPrivate: 1,
          distanceMeters: 1,
          viewerIsFollower: { $in: [viewerId, "$followers"] },
          viewerRequested: { $in: [viewerId, "$followRequests"] },
          targetFollowsViewer: { $in: [viewerId, "$following"] },
        },
      },
      { $limit: limit },
    ]);

    const viewerDoc = await User.findById(viewerId).select("followers following");
    const viewerFriends = buildMutualFollowSet(viewerDoc);

    const users = docs.map((doc) => {
      const candidateFollowing = new Set(Array.isArray(doc.following) ? doc.following.map((id) => String(id)) : []);
      const mutualFollowCount = Array.from(viewerFriends).reduce((acc, id) => acc + (candidateFollowing.has(id) ? 1 : 0), 0);
      let followStatus = "not_following";
      if (doc.viewerIsFollower) followStatus = "following";
      else if (doc.viewerRequested) followStatus = "requested";
      else if (doc.targetFollowsViewer) followStatus = "follow_back";
      return {
        _id: doc._id,
        name: doc.name,
        nickname: doc.nickname,
        avatarUrl: doc.avatarUrl,
        isPrivate: !!doc.isPrivate,
        distanceKm: Number((doc.distanceMeters / 1000).toFixed(2)),
        location: Array.isArray(doc?.location?.coordinates) && doc.location.coordinates.length === 2
          ? { lng: doc.location.coordinates[0], lat: doc.location.coordinates[1] }
          : null,
        mutualFriendCount: mutualFollowCount,
        followStatus,
      };
    });
    res.json({ users });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const uploadAvatar = async (req, res) => {
  try {
    ensureCloudinaryConfigured();
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });
    // Basic validation
    if (!/^image\//.test(req.file.mimetype)) return res.status(400).json({ message: "File must be an image" });
    // Resize & convert to webp buffer with sharp
    const processed = await sharp(req.file.buffer)
      .resize(256, 256, { fit: "cover" })
      .webp({ quality: 80 })
      .toBuffer();
    let avatarUrl;
    if (isCloudinaryConfigured()) {
      // Simpler: upload base64 data URI (avoids stream piping complexity)
      const dataUri = `data:image/webp;base64,${processed.toString('base64')}`;
      const result = await cloudinary.v2.uploader.upload(dataUri, {
        folder: "flowsnap/avatars",
        overwrite: true,
        resource_type: "image",
      });
      avatarUrl = result.secure_url;
    } else {
      // Fallback: save locally under /uploads/avatars
      const uploadsRoot = path.join(process.cwd(), 'uploads');
      const avatarsDir = path.join(uploadsRoot, 'avatars');
      await fs.mkdir(avatarsDir, { recursive: true }).catch(() => {});
      const name = `${crypto.randomBytes(12).toString('hex')}.webp`;
      const outPath = path.join(avatarsDir, name);
      await fs.writeFile(outPath, processed);
      avatarUrl = `/uploads/avatars/${name}`;
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });
    user.avatarUrl = avatarUrl;
    await user.save();
    res.json({ avatarUrl: user.avatarUrl });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// Online users will be tracked in socket.js; we expose an endpoint to query
export const listOnlineUsers = async (req, res) => {
  try {
    const onlineIds = Array.from(getOnlineUsers());
    const users = await User.find({ _id: { $in: onlineIds } }).select("_id name nickname email avatarUrl lastActiveAt isVerified verificationType");
    res.json({ users });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

export const getUserBasic = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId).select('_id name nickname avatarUrl lastActiveAt isVerified verificationType');
    if (!user) return res.status(404).json({ message: 'User not found' });
    const normalizedUserId = String(userId);
    const isOnline = getSocketIdsForUser(normalizedUserId).length > 0 || getOnlineUsers().has(normalizedUserId);
    res.json({ user: { ...user.toObject(), isOnline } });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

export const getUserPublicProfile = async (req, res) => {
  try {
    const { userId } = req.params;
    let user = null;
    const raw = String(userId || '').trim();
    const normalized = raw.toLowerCase();
    const alt = normalized.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (mongoose.Types.ObjectId.isValid(userId)) {
      user = await User.findById(userId).select('_id name nickname avatarUrl interests bio profileLikes isPrivate followers following followRequests isVerified verificationType');
    }
    if (!user) {
      user = await User.findOne({ nameLower: normalized }).select('_id name nickname avatarUrl interests bio profileLikes isPrivate followers following followRequests isVerified verificationType');
      if (!user && alt && alt !== normalized) {
        user = await User.findOne({ nameLower: alt }).select('_id name nickname avatarUrl interests bio profileLikes isPrivate followers following followRequests isVerified verificationType');
      }
    }
    if (!user) return res.status(404).json({ message: 'User not found' });
    const targetId = String(user._id);
    const viewerId = req.user._id;
    const [viewerProfile, postCount, followerCount, followingCount] = await Promise.all([
      User.findById(viewerId).select('interests'),
      Post.countDocuments({
        author: targetId,
        isDelete: { $ne: true },
        isDeleted: { $ne: true },
      }),
      countActiveVerifiedUsers(user.followers),
      countActiveVerifiedUsers(user.following),
    ]);

    const includesId = (list, id) => Array.isArray(list) && list.some((entry) => String(entry) === String(id));
    const profileLikeCount = Array.isArray(user.profileLikes) ? user.profileLikes.length : 0;
    const followerCountSafe = Number.isFinite(followerCount) ? followerCount : 0;
    const followingCountSafe = Number.isFinite(followingCount) ? followingCount : 0;
    const likedByMe = includesId(user.profileLikes, viewerId);
    const viewerIsOwner = String(targetId) === String(viewerId);
    const viewerFollows = includesId(user.followers, viewerId);
    const viewerPending = includesId(user.followRequests, viewerId);
    const targetFollowsViewer = includesId(user.following, viewerId);
    let followStatus = 'not_following';
    if (viewerIsOwner) followStatus = 'self';
    else if (viewerFollows) followStatus = 'following';
    else if (viewerPending) followStatus = 'requested';
    else if (targetFollowsViewer) followStatus = 'follow_back';
    const canViewPosts = viewerIsOwner || !user.isPrivate || viewerFollows;

    const viewerInterests = Array.isArray(viewerProfile?.interests) ? viewerProfile.interests.filter(Boolean) : [];
    const viewerInterestSet = new Set(viewerInterests.map((item) => String(item).toLowerCase()));
    const sharedInterestsRaw = Array.isArray(user.interests) ? user.interests.filter(Boolean) : [];
    const sharedInterests = viewerInterestSet.size
      ? sharedInterestsRaw.filter((interest) => viewerInterestSet.has(String(interest).toLowerCase()))
      : [];

    res.json({ user: {
      _id: user._id,
      name: user.name,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      interests: user.interests,
      bio: user.bio,
      followerCount: followerCountSafe,
      followingCount: followingCountSafe,
      profileLikeCount,
      likedByMe,
      isPrivate: !!user.isPrivate,
      isVerified: !!user.isVerified,
      verificationType: user.verificationType || null,
      postCount,
      canViewPosts,
      followStatus,
      sharedInterests: sharedInterests.slice(0, 10),
    } });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

export const toggleProfileLike = async (req, res) => {
  try {
    const { userId } = req.params;
    if (String(userId) === String(req.user._id)) return res.status(400).json({ message: 'Cannot like your own profile' });
    const user = await User.findById(userId).select('_id profileLikes');
    if (!user) return res.status(404).json({ message: 'User not found' });
    const already = Array.isArray(user.profileLikes) && user.profileLikes.some(id => String(id) === String(req.user._id));
    if (already) {
      user.profileLikes = user.profileLikes.filter(id => String(id) !== String(req.user._id));
    } else {
      user.profileLikes.push(req.user._id);
    }
    await user.save();
    // Emit socket event to profile owner for realtime update
    try {
      const io = getIO();
      io.to(`user:${user._id}`).emit('profile:likeUpdated', { userId: String(user._id), profileLikeCount: user.profileLikes.length });
    } catch {}
    res.json({ liked: !already, profileLikeCount: user.profileLikes.length });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

export const listProfileLikers = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId).select('profileLikes');
    if (!user) return res.status(404).json({ message: 'User not found' });
    const ids = user.profileLikes || [];
    if (!ids.length) return res.json({ users: [] });
    const likers = await User.find({ _id: { $in: ids } }).select('_id name avatarUrl');
    // Preserve original order (latest push at end) by mapping
    const map = new Map(likers.map(u => [String(u._id), u]));
    const ordered = ids.map(id => map.get(String(id))).filter(Boolean);
    res.json({ users: ordered });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

export const removeFriend = async (req, res) => {
  try {
    const otherId = req.params.userId;
    await removeFriendshipBetween(req.user._id, otherId);
    return res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const listBlockedUsers = async (req, res) => {
  try {
    const me = await User.findById(req.user._id).select('blockedUsers');
    const ids = me?.blockedUsers || [];
    if (!ids.length) return res.json({ users: [] });
    const users = await User.find({ _id: { $in: ids } }).select('_id name email avatarUrl');
    const map = new Map(users.map((u) => [String(u._id), u]));
    const ordered = ids.map((id) => map.get(String(id))).filter(Boolean);
    res.json({ users: ordered });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const blockUser = async (req, res) => {
  try {
    const { userId } = req.params;
    if (String(userId) === String(req.user._id)) return res.status(400).json({ message: 'Cannot block yourself' });
    const target = await User.findById(userId).select('_id name email avatarUrl');
    if (!target) return res.status(404).json({ message: 'User not found' });
    await User.findByIdAndUpdate(req.user._id, { $addToSet: { blockedUsers: target._id } });
    await removeFriendshipBetween(req.user._id, target._id);
    res.json({ user: target });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const unblockUser = async (req, res) => {
  try {
    const { userId } = req.params;
    await User.findByIdAndUpdate(req.user._id, { $pull: { blockedUsers: userId } });
    res.json({ userId });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// Get followers list for a user
export const getFollowersList = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user._id;
    
    const targetUser = await User.findById(userId).select('followers isPrivate');
    if (!targetUser) return res.status(404).json({ message: "User not found" });
    
    // If private account and not the owner, check if current user follows them
    if (targetUser.isPrivate && String(userId) !== String(currentUserId)) {
      const isFollowing = targetUser.followers.some(id => String(id) === String(currentUserId));
      if (!isFollowing) {
        return res.status(403).json({ message: "This account is private" });
      }
    }
    
    // Populate followers
    const followers = await User.find({
      _id: { $in: targetUser.followers },
      ...ACTIVE_VERIFIED_USER,
    }).select('_id name avatarUrl').lean();
    
    res.json({ users: followers });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// Get following list for a user
export const getFollowingList = async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.user._id;
    
    const targetUser = await User.findById(userId).select('following isPrivate followers');
    if (!targetUser) return res.status(404).json({ message: "User not found" });
    
    // If private account and not the owner, check if current user follows them
    if (targetUser.isPrivate && String(userId) !== String(currentUserId)) {
      const isFollowing = targetUser.followers.some(id => String(id) === String(currentUserId));
      if (!isFollowing) {
        return res.status(403).json({ message: "This account is private" });
      }
    }
    
    // Populate following
    const following = await User.find({
      _id: { $in: targetUser.following },
      ...ACTIVE_VERIFIED_USER,
    }).select('_id name avatarUrl').lean();
    
    res.json({ users: following });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// Recommend friends based on overlapping interests and not already connected or pending
export const recommendFriends = async (req, res) => {
  try {
    const users = await buildFriendRecommendations(req.user._id);
    res.json({ users });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const updatePushToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token || typeof token !== 'string') return res.status(400).json({ message: "Token required" });

    const now = new Date();

    // IMPORTANT: tokens are device-scoped, not account-scoped.
    // If the same device logs into a different account, we must move the token.
    // Otherwise pushes can go to the wrong user (exact issue reported).
    const dedupeRes = await User.updateMany(
      { pushToken: token, _id: { $ne: req.user._id } },
      { $unset: { pushToken: 1, pushTokenUpdatedAt: 1 } }
    ).catch(() => null);

    const updated = await User.findByIdAndUpdate(
      req.user._id,
      { pushToken: token, pushTokenUpdatedAt: now },
      { new: true }
    ).select("_id pushToken pushTokenUpdatedAt");

    // Helpful server log for debugging token freshness (don’t print full token)
    const tokenSuffix = typeof token === 'string' ? token.slice(-12) : '';
    const moved = dedupeRes && typeof dedupeRes.modifiedCount === 'number' ? dedupeRes.modifiedCount : null;
    console.log(`[push] token updated user=${String(req.user._id)} suffix=${tokenSuffix} movedFromOthers=${moved} at=${now.toISOString()}`);

    res.json({ ok: true, pushTokenUpdatedAt: updated?.pushTokenUpdatedAt || now });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const clearPushToken = async (req, res) => {
  try {
    const now = new Date();
    await User.findByIdAndUpdate(
      req.user._id,
      { $unset: { pushToken: 1, pushTokenUpdatedAt: 1 } },
      { new: false }
    );

    console.log(`[push] token cleared user=${String(req.user._id)} at=${now.toISOString()}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const getMyPushTokenStatus = async (req, res) => {
  try {
    const me = await User.findById(req.user._id).select("_id pushToken pushTokenUpdatedAt").lean();
    if (!me) return res.status(404).json({ message: "User not found" });

    const token = me.pushToken || null;
    res.json({
      hasToken: Boolean(token),
      tokenSuffix: token ? String(token).slice(-12) : null,
      pushTokenUpdatedAt: me.pushTokenUpdatedAt || null,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

function buildDeletedEmail(userId) {
  const token = crypto.randomBytes(6).toString('hex');
  return `deleted+${String(userId)}+${Date.now()}+${token}@deleted.local`;
}

function buildDeletedName(userId) {
  const token = crypto.randomBytes(4).toString('hex');
  return `DeletedUser_${String(userId).slice(-6)}_${token}`;
}

export const deactivateAccount = async (req, res) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.status === 'deactivated') {
      return res.status(200).json({ ok: true, status: 'deactivated' });
    }

    user.status = 'deactivated';
    user.deactivatedAt = new Date();
    user.pushToken = null;
    user.pushTokenUpdatedAt = null;
    user.refreshTokens = [];

    await user.save();
    return res.status(200).json({ ok: true, status: 'deactivated' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const deleteAccount = async (req, res) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const deletedName = buildDeletedName(userId);
    const deletedEmail = buildDeletedEmail(userId);

    await Promise.all([
      User.updateMany({ followers: userId }, { $pull: { followers: userId } }),
      User.updateMany({ following: userId }, { $pull: { following: userId } }),
      User.updateMany({ followRequests: userId }, { $pull: { followRequests: userId } }),
      User.updateMany({ blockedUsers: userId }, { $pull: { blockedUsers: userId } }),
      User.updateMany({ profileLikes: userId }, { $pull: { profileLikes: userId } }),
      User.updateMany({ 'messageRequests.from': userId }, { $pull: { messageRequests: { from: userId } } }),
    ]);

    user.status = 'deactivated';
    user.isDeleted = true;
    user.deletedAt = new Date();
    user.deactivatedAt = user.deactivatedAt || new Date();
    user.email = deletedEmail;
    user.name = deletedName;
    user.nickname = null;
    user.bio = null;
    user.avatarUrl = null;
    user.followers = [];
    user.following = [];
    user.followRequests = [];
    user.messageRequests = [];
    user.blockedUsers = [];
    user.profileLikes = [];
    user.pushToken = null;
    user.pushTokenUpdatedAt = null;
    user.refreshTokens = [];

    await user.save();
    return res.status(200).json({ ok: true, status: 'deleted' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};
