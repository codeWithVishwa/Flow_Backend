import cloudinary from "cloudinary";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import Post from "../models/post.model.js";
import PostView from "../models/postView.model.js";
import User from "../models/user.model.js";
import Comment from "../models/comment.model.js";
import Notification from "../models/notification.model.js";
import { sendPushNotification } from "../utils/expoPush.js";
import { getOnlineUsers, getSocketIdsForUser } from "../socket.js";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

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

function ensureFfmpegConfigured() {
  if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath);
  }
}

function generateVideoThumbnail(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ensureFfmpegConfigured();
    const folder = path.dirname(outputPath);
    const filename = path.basename(outputPath);
    ffmpeg(inputPath)
      .on("end", () => resolve(outputPath))
      .on("error", reject)
      .screenshots({
        timestamps: ["00:00:00.200"],
        filename,
        folder,
        size: "640x?",
      });
  });
}
const MAX_VIDEO_SECONDS = 20;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const ALLOWED_VIDEO_FORMAT = "mp4";
const ALLOWED_SOURCE_VIDEO_FORMATS = new Set(["mp4", "mov", "m4v", "webm", "3gp", "mkv"]);
const MAX_MEDIA_PER_POST = 4;
const VIDEO_UPLOAD_TRANSFORMATION = "q_auto:good,vc_auto";
const VIEW_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const CLOUDINARY_RESOURCE_RETRY_DELAYS_MS = [250, 600, 1200];
const MAX_TAGS_PER_POST = 20;
const MAX_INTEREST_TOKENS = 8;
const ADULT_SIGNAL_TAGS = new Set(["adult", "mature", "hood", "nsfw", "18plus", "dark"]);
const NIGHT_START_HOUR = 21; // 9 PM
const NIGHT_END_HOUR = 5; // 5 AM

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTag(value) {
  if (!value) return "";
  return String(value).trim().toLowerCase().replace(/[^a-z0-9_#\s-]/g, "").replace(/\s+/g, " ");
}

function extractHashtags(caption) {
  if (!caption) return [];
  const tags = caption.match(/#([A-Za-z0-9_]+)/g) || [];
  return tags.map((t) => normalizeTag(t.replace("#", ""))).filter(Boolean);
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v === "true" || v === "1" || v === "yes";
  }
  return false;
}

function hasAdultSignal(tags) {
  if (!Array.isArray(tags)) return false;
  return tags.some((t) => ADULT_SIGNAL_TAGS.has(normalizeTag(t)));
}

function isNightTimeNow() {
  const hour = new Date().getHours();
  return hour >= NIGHT_START_HOUR || hour <= NIGHT_END_HOUR;
}

function buildInterestRegex(interests) {
  if (!Array.isArray(interests) || interests.length === 0) return null;
  const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = interests.map(escapeRegex).filter(Boolean);
  if (!parts.length) return null;
  return new RegExp(`\\b(${parts.join("|")})\\b`, "i");
}

function scorePostByInterests(post, interestSet) {
  if (!post || !interestSet || interestSet.size === 0) return 0;
  const tags = Array.isArray(post.tags) ? post.tags : [];
  let matchCount = 0;
  tags.forEach((tag) => {
    const normalized = normalizeTag(tag);
    if (normalized && interestSet.has(normalized)) matchCount += 1;
  });
  const caption = normalizeTag(post.caption || "");
  let captionHits = 0;
  if (caption) {
    for (const interest of interestSet) {
      if (caption.includes(interest)) captionHits += 1;
    }
  }
  const likes = Array.isArray(post.likes) ? post.likes.length : 0;
  const comments = typeof post.commentCount === "number" ? post.commentCount : 0;
  const views = Math.max(Number(post.viewCount || 0), Number(post.playCount || 0), 0);
  const ageHours = Math.max(1, (Date.now() - new Date(post.createdAt).getTime()) / (1000 * 60 * 60));
  const freshness = Math.max(0, 36 - ageHours);
  return matchCount * 8 + captionHits * 3 + likes * 2 + comments * 2 + views * 0.3 + freshness * 0.4;
}

function extractCaptionTokens(caption) {
  const normalized = normalizeTag(caption || "");
  if (!normalized) return [];
  return normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !token.startsWith("#"))
    .slice(0, 20);
}

function hasImageMedia(post) {
  return Array.isArray(post?.media) && post.media.some((m) => m?.type === "image" && m?.url);
}

function overlapCount(aSet, values) {
  if (!aSet || !(aSet instanceof Set) || aSet.size === 0 || !Array.isArray(values) || values.length === 0) return 0;
  let count = 0;
  values.forEach((v) => {
    const key = normalizeTag(v);
    if (key && aSet.has(key)) count += 1;
  });
  return count;
}

function interleavePosts(primary, recommended, limit) {
  const result = [];
  let recIdx = 0;
  const every = 3;
  for (let i = 0; i < primary.length && result.length < limit; i += 1) {
    result.push(primary[i]);
    if ((i + 1) % every === 0 && recIdx < recommended.length && result.length < limit) {
      result.push(recommended[recIdx]);
      recIdx += 1;
    }
  }
  while (recIdx < recommended.length && result.length < limit) {
    result.push(recommended[recIdx]);
    recIdx += 1;
  }
  return result;
}

function parseCloudinaryPublicIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/cloudinary\.com$/i.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split("/upload/");
    if (parts.length < 2) return null;
    const tail = parts[1].split(/[?#]/)[0];
    const withoutVersion = tail.replace(/^v\d+\//, "");
    return withoutVersion.replace(/\.[a-z0-9]+$/i, "");
  } catch {
    return null;
  }
}

async function validateCloudinaryVideoMediaItem(item) {
  ensureCloudinaryConfigured();

  const providedUrl = safeString(item?.url);
  if (!providedUrl || !providedUrl.startsWith("https://")) {
    throw new Error("Video URL must be a valid secure URL.");
  }

  const providedPublicId = safeString(item?.publicId);
  const derivedPublicId = parseCloudinaryPublicIdFromUrl(providedUrl);
  const publicId = providedPublicId || derivedPublicId;
  if (!publicId) {
    throw new Error("Video publicId is required.");
  }

  const fetchVideoResource = async (id) => {
    let lastErr = null;
    for (let i = 0; i <= CLOUDINARY_RESOURCE_RETRY_DELAYS_MS.length; i += 1) {
      try {
        return await cloudinary.v2.api.resource(id, { resource_type: "video" });
      } catch (err) {
        lastErr = err;
        if (i >= CLOUDINARY_RESOURCE_RETRY_DELAYS_MS.length) break;
        await new Promise((resolve) => setTimeout(resolve, CLOUDINARY_RESOURCE_RETRY_DELAYS_MS[i]));
      }
    }
    throw lastErr;
  };

  const resource = await fetchVideoResource(publicId);

  if (!resource?.secure_url) {
    throw new Error("Video asset not found in Cloudinary.");
  }

  const durationSeconds = Number(resource.duration) || 0;
  const bytes = Number(resource.bytes) || 0;
  const format = safeString(resource.format).toLowerCase();

  if (durationSeconds > MAX_VIDEO_SECONDS) {
    throw new Error(`Videos must be ${MAX_VIDEO_SECONDS} seconds or shorter.`);
  }
  if (bytes > MAX_VIDEO_BYTES) {
    throw new Error("Video size exceeds 20MB.");
  }
  if (!ALLOWED_SOURCE_VIDEO_FORMATS.has(format)) {
    throw new Error("Unsupported video format.");
  }

  const optimizedUrl = cloudinary.v2.url(publicId, {
    resource_type: "video",
    secure: true,
    format: "mp4",
    transformation: [
      {
        quality: "auto:good",
        video_codec: "auto",
      },
    ],
  });
  const thumbnailUrl = cloudinary.v2.url(publicId, {
    resource_type: "video",
    format: "jpg",
    transformation: [{ start_offset: "0", width: 640, crop: "scale" }],
  });

  return {
    url: optimizedUrl || resource.secure_url,
    secureUrl: resource.secure_url,
    type: "video",
    publicId: resource.public_id,
    assetId: resource.asset_id,
    thumbnailUrl,
    width: resource.width,
    height: resource.height,
    durationSeconds: Math.round(durationSeconds),
    format: ALLOWED_VIDEO_FORMAT,
    bytes,
  };
}

async function getFollowingIds(userId) {
  const user = await User.findById(userId).select("following");
  const ids = new Set();
  if (user && Array.isArray(user.following)) {
    user.following.forEach(id => ids.add(String(id)));
  }
  return ids;
}

function serializePost(post, viewerId, savedSet) {
  const likes = Array.isArray(post.likes) ? post.likes.map((id) => String(id)) : [];
    return {
      _id: post._id,
      caption: post.caption,
      tags: Array.isArray(post.tags) ? post.tags : [],
      isAdult: !!post.isAdult,
      media: post.media,
    visibility: post.visibility,
    createdAt: post.createdAt,
    durationSeconds: Array.isArray(post.media)
      ? post.media.find((m) => m?.type === "video" && Number.isFinite(m?.durationSeconds))?.durationSeconds
      : undefined,
    commentCount: typeof post.commentCount === "number" ? post.commentCount : 0,
    hideLikeCount: !!post.hideLikeCount,
    commentsDisabled: !!post.commentsDisabled,
    author: post.author
      ? {
          _id: post.author._id,
          name: post.author.name,
          avatarUrl: post.author.avatarUrl,
          isPrivate: post.author.isPrivate,
          isVerified: !!post.author.isVerified,
          verificationType: post.author.verificationType || null,
        }
      : null,
    likeCount: likes.length,
    viewCount: Number(post.viewCount || 0),
    playCount: Number(post.playCount || 0),
    likedByMe: viewerId ? likes.includes(String(viewerId)) : false,
    savedByMe: savedSet ? savedSet.has(String(post._id)) : false,
  };
}

function isVideoPost(post) {
  return Array.isArray(post?.media) && post.media.some((m) => m?.type === "video" && m?.url);
}

async function getSavedSetForUser(userId) {
  if (!userId) return new Set();
  const user = await User.findById(userId).select("savedPosts");
  const saved = Array.isArray(user?.savedPosts) ? user.savedPosts : [];
  return new Set(saved.map((item) => String(item.post || item?._id)).filter(Boolean));
}

function serializeComment(comment) {
  const parentId = comment.parent ? String(comment.parent._id || comment.parent) : null;
  const parentAuthor = comment.parent && comment.parent.author
    ? {
        _id: comment.parent.author._id,
        name: comment.parent.author.name,
        avatarUrl: comment.parent.author.avatarUrl,
      }
    : null;
  return {
    _id: comment._id,
    text: comment.text,
    createdAt: comment.createdAt,
    author: comment.author
      ? {
          _id: comment.author._id,
          name: comment.author.name,
          avatarUrl: comment.author.avatarUrl,
          isVerified: !!comment.author.isVerified,
          verificationType: comment.author.verificationType || null,
        }
      : null,
    parentId,
    parentAuthor,
  };
}

function uploadBuffer(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.v2.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    stream.end(buffer);
  });
}

async function ensureVideoThumbnail(post) {
  if (!post || !Array.isArray(post.media)) return post;
  const idx = post.media.findIndex((m) => m?.type === "video" && m?.url);
  if (idx < 0) return post;
  const video = post.media[idx];
  if (video?.thumbnailUrl) return post;

  let thumbnailUrl = null;

  if (video?.publicId) {
    ensureCloudinaryConfigured();
    thumbnailUrl = cloudinary.v2.url(video.publicId, {
      resource_type: "video",
      format: "jpg",
      transformation: [{ width: 640, crop: "scale" }],
    });
  } else if (video?.url && String(video.url).startsWith("/uploads/")) {
    try {
      const ownerId = post.author?._id || post.author;
      const inputPath = path.join(process.cwd(), video.url);
      const thumbDir = path.join(process.cwd(), "uploads", "thumbs", String(ownerId));
      await fs.mkdir(thumbDir, { recursive: true });
      const thumbName = `${path.parse(video.url).name}.jpg`;
      const thumbPath = path.join(thumbDir, thumbName);
      await generateVideoThumbnail(inputPath, thumbPath);
      thumbnailUrl = `/uploads/thumbs/${String(ownerId)}/${thumbName}`;
    } catch {
      thumbnailUrl = null;
    }
  }

  if (thumbnailUrl) {
    post.media[idx] = { ...video, thumbnailUrl };
    await Post.updateOne(
      { _id: post._id, "media.url": video.url },
      { $set: { "media.$.thumbnailUrl": thumbnailUrl } },
    ).catch(() => {});
  }

  return post;
}

async function canViewPost(viewerId, post) {
  if (!post) return false;
  const authorId = post.author && post.author._id ? post.author._id : post.author;
  if (String(authorId) === String(viewerId)) return true;
  if (post.visibility === "public") return true;
  // For private posts, viewer must be following the author
  const followingIds = await getFollowingIds(viewerId);
  return followingIds.has(String(authorId));
}

export const uploadPostMedia = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file provided" });
    const isVideo = req.file.mimetype.startsWith("video/");
    if (isVideo) {
      return res.status(400).json({
        message: "Direct video upload via backend is disabled. Use signed Cloudinary upload.",
      });
    }
    const nodeEnv = String(process.env.NODE_ENV || "").toLowerCase();
    const useCloudinary = nodeEnv === "developement" || nodeEnv === "development";

    if (useCloudinary) {
      ensureCloudinaryConfigured();
      const resourceType = isVideo ? "video" : "image";
      const folder = `flowsnap/posts/${req.user._id}`;
      const result = await uploadBuffer(req.file.buffer, {
        folder,
        resource_type: resourceType,
        overwrite: false,
      });
      if (isVideo && result.duration && result.duration > MAX_VIDEO_SECONDS) {
        await cloudinary.v2.uploader.destroy(result.public_id, { resource_type: "video" }).catch(() => {});
        return res.status(400).json({ message: `Videos must be under ${MAX_VIDEO_SECONDS} seconds.` });
      }
      const thumbnailUrl = isVideo
        ? cloudinary.v2.url(result.public_id, {
            resource_type: "video",
            format: "jpg",
            transformation: [{ width: 640, crop: "scale" }],
          })
        : undefined;
      const media = {
        url: result.secure_url,
        type: isVideo ? "video" : "image",
        publicId: result.public_id,
        thumbnailUrl,
        width: result.width,
        height: result.height,
        durationSeconds: result.duration ? Math.round(result.duration) : undefined,
      };
      return res.status(201).json({ media });
    }

    const uploadsRoot = path.join(process.cwd(), "uploads");
    const postsDir = path.join(uploadsRoot, "posts", String(req.user._id));
    await fs.mkdir(postsDir, { recursive: true });

    const originalExt = path.extname(req.file.originalname || "").toLowerCase();
    const safeExt = originalExt || (isVideo ? ".mp4" : ".jpg");
    const filename = `${Date.now()}_${crypto.randomBytes(6).toString("hex")}${safeExt}`;
    const filepath = path.join(postsDir, filename);
    await fs.writeFile(filepath, req.file.buffer);

    let thumbnailUrl = undefined;
    if (isVideo) {
      const thumbsDir = path.join(uploadsRoot, "thumbs", String(req.user._id));
      await fs.mkdir(thumbsDir, { recursive: true });
      const thumbName = `${path.parse(filename).name}.jpg`;
      const thumbPath = path.join(thumbsDir, thumbName);
      try {
        await generateVideoThumbnail(filepath, thumbPath);
        thumbnailUrl = `/uploads/thumbs/${String(req.user._id)}/${thumbName}`;
      } catch {}
    }

    const media = {
      url: `/uploads/posts/${String(req.user._id)}/${filename}`,
      type: isVideo ? "video" : "image",
      thumbnailUrl,
    };
    return res.status(201).json({ media });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const generateVideoUploadSignature = async (req, res) => {
  try {
    ensureCloudinaryConfigured();
    const cfg = cloudinary.v2.config();
    if (!cfg.api_key || !cfg.api_secret || !cfg.cloud_name) {
      return res.status(500).json({ message: "Cloudinary is not configured." });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `flowsnap/posts/${String(req.user._id)}`;
    const eager = "f_auto,q_auto,vc_auto";
      const paramsToSign = {
        timestamp,
        folder,
        transformation: VIDEO_UPLOAD_TRANSFORMATION,
        eager,
        eager_async: "false",
      };
    const signature = cloudinary.v2.utils.api_sign_request(paramsToSign, cfg.api_secret);

    return res.json({
      cloudName: cfg.cloud_name,
      apiKey: cfg.api_key,
      timestamp,
      signature,
      folder,
      resourceType: "video",
      allowedFormats: ALLOWED_VIDEO_FORMAT,
      maxFileSize: MAX_VIDEO_BYTES,
      transformation: VIDEO_UPLOAD_TRANSFORMATION,
      eager,
      eagerAsync: "false",
    });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Unable to create upload signature." });
  }
};

export const createPost = async (req, res) => {
  try {
    const author = await User.findById(req.user._id).select("_id isPrivate name avatarUrl");
    if (!author) return res.status(404).json({ message: "User not found" });

    const caption = typeof req.body.caption === "string" ? req.body.caption.trim().slice(0, 500) : "";
      const incomingMedia = Array.isArray(req.body.media) ? req.body.media : [];
      const incomingTags = Array.isArray(req.body.tags) ? req.body.tags : [];
      const tags = Array.from(new Set([
        ...incomingTags.map(normalizeTag),
        ...extractHashtags(caption),
      ].filter(Boolean)))
        .slice(0, MAX_TAGS_PER_POST);
      const explicitAdult = parseBoolean(req.body?.isAdult);
      const isAdult = explicitAdult || hasAdultSignal(tags);
    const mediaInput = incomingMedia
      .slice(0, MAX_MEDIA_PER_POST)
      .map((item) => ({
        url: item?.url,
        secureUrl: item?.secureUrl,
        type: item?.type === "video" ? "video" : "image",
        publicId: item?.publicId,
        assetId: item?.assetId,
        format: item?.format,
        bytes: item?.bytes,
        thumbnailUrl: item?.thumbnailUrl,
        width: item?.width,
        height: item?.height,
        durationSeconds: item?.durationSeconds,
      }))
      .filter((item) => item.url);

    if (!caption && mediaInput.length === 0) {
      return res.status(400).json({ message: "Post must include text or media" });
    }

    const videoCount = mediaInput.filter((m) => m.type === "video").length;
    if (videoCount > 1) return res.status(400).json({ message: "Only one video allowed per post" });

    const media = [];
    for (const item of mediaInput) {
      if (item.type === "video") {
        let validatedVideo = null;
        try {
          validatedVideo = await validateCloudinaryVideoMediaItem(item);
        } catch (videoError) {
          return res.status(400).json({ message: videoError?.message || "Invalid video upload." });
        }
        media.push(validatedVideo);
      } else {
        media.push({
          url: item.url,
          secureUrl: safeString(item.secureUrl) || undefined,
          type: "image",
          publicId: safeString(item.publicId) || undefined,
          thumbnailUrl: safeString(item.thumbnailUrl) || undefined,
          width: Number.isFinite(item.width) ? item.width : undefined,
          height: Number.isFinite(item.height) ? item.height : undefined,
        });
      }
    }

      const post = await Post.create({
        author: author._id,
        caption,
        tags,
        isAdult,
        media,
        visibility: author.isPrivate ? "private" : "public",
      });

    const populated = await post.populate("author", "_id name avatarUrl isPrivate isVerified verificationType");
    res.status(201).json({ post: serializePost(populated, req.user._id, new Set()) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const listFeedPosts = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const before = req.query.before ? new Date(req.query.before) : null;
    const contentType = safeString(req.query.contentType).toLowerCase();
    const videoOnly = contentType === "video" || contentType === "clips";
    const savedSet = await getSavedSetForUser(req.user._id);

    const me = await User.findById(req.user._id).select("_id interests gender");
    const interestTokens = Array.isArray(me?.interests)
      ? me.interests.map(normalizeTag).filter(Boolean).slice(0, MAX_INTEREST_TOKENS)
      : [];
    const interestSet = new Set(interestTokens);
    const gender = safeString(me?.gender).toLowerCase();
    const isFemaleUser = new Set(["female", "woman", "girl", "f"]).has(gender);
    const adultBoostMultiplier = isFemaleUser ? 0.25 : 1;

    const followingIds = await getFollowingIds(req.user._id);
    const followPlusSelf = new Set(Array.from(followingIds).concat([String(req.user._id)]));

    const likedPosts = await Post.find({
      likes: req.user._id,
      isDelete: { $ne: true },
      isDeleted: { $ne: true },
    })
      .select("tags caption media")
      .sort({ updatedAt: -1 })
      .limit(120);

    const likedTagSet = new Set();
    const likedTokenSet = new Set();
    likedPosts.forEach((post) => {
      (Array.isArray(post.tags) ? post.tags : []).forEach((tag) => {
        const normalized = normalizeTag(tag);
        if (normalized) likedTagSet.add(normalized);
      });
      extractCaptionTokens(post.caption).forEach((token) => likedTokenSet.add(token));
    });

    const candidateQuery = {
      $or: [
        { author: { $in: Array.from(followPlusSelf) } },
        { visibility: "public" },
      ],
      isDelete: { $ne: true },
      isDeleted: { $ne: true },
    };
    if (videoOnly) {
      candidateQuery.media = { $elemMatch: { type: "video", url: { $exists: true, $ne: "" } } };
    }
    if (before && !isNaN(before.getTime())) {
      candidateQuery.createdAt = { $lt: before };
    }

    const candidateLimit = Math.min(700, Math.max(limit * 30, 200));
    const candidates = await Post.find(candidateQuery)
      .sort({ createdAt: -1 })
      .limit(candidateLimit)
      .populate("author", "_id name avatarUrl isPrivate isVerified verificationType");

    const scored = candidates
      .filter((post) => {
        const authorId = String(post?.author?._id || post?.author || "");
        if (!authorId) return false;
        if (followPlusSelf.has(authorId)) return true;
        return post.visibility === "public";
      })
      .map((post) => {
        const tags = Array.isArray(post.tags) ? post.tags : [];
        const captionTokens = extractCaptionTokens(post.caption);
        const likes = Array.isArray(post.likes) ? post.likes.length : 0;
        const comments = Number(post.commentCount || 0);
        const views = Math.max(Number(post.viewCount || 0), Number(post.playCount || 0), 0);
        const isFollowing = followPlusSelf.has(String(post?.author?._id || post?.author));
        const publicDiscover = post.visibility === "public" ? 1 : 0;
        const ageHours = Math.max(1, (Date.now() - new Date(post.createdAt).getTime()) / (1000 * 60 * 60));
        const freshness = Math.max(0, 48 - ageHours);
        const interestScore = scorePostByInterests(post, interestSet);
        const likedTagScore = overlapCount(likedTagSet, tags) * 5;
        const likedCaptionScore = overlapCount(likedTokenSet, captionTokens) * 2.2;
        const engagementScore = likes * 1.8 + comments * 1.6 + views * 0.12;
        const affinityScore = (isFollowing ? 4.5 : 0) + publicDiscover * 1.4;
        const postAdult = !!post.isAdult || hasAdultSignal(tags);
        const coldStart = likedPosts.length < 3;
        const adultInterest = interestTokens.some((t) => ADULT_SIGNAL_TAGS.has(t));
        const randomJitter = Math.random() * 6.2;
        const nightTime = isNightTimeNow();
        const adultBoostRaw = postAdult
          ? (
            nightTime
              ? (coldStart ? 2.8 : (adultInterest ? 1.4 : 0.6))
              : (adultInterest ? 0.15 : 0)
          )
          : 0;
        const adultBoost = adultBoostRaw * adultBoostMultiplier;
        const finalScore = interestScore + likedTagScore + likedCaptionScore + engagementScore + freshness * 0.35 + affinityScore + adultBoost + randomJitter;
        const personalizedSignal =
          isFollowing ||
          interestScore > 0 ||
          likedTagScore > 0 ||
          likedCaptionScore > 0;
        return { post, finalScore, personalizedSignal };
      });

    scored.sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));
    const personalizedPool = scored.filter((entry) => entry.personalizedSignal);
    const fallbackPool = scored.filter((entry) => !entry.personalizedSignal);

    const pickFromPool = (pool, count, windowSize = 6) => {
      const picked = [];
      const mutable = pool.slice();
      while (mutable.length && picked.length < count) {
        const window = Math.min(windowSize, mutable.length);
        const randomIndex = Math.floor(Math.random() * window);
        picked.push(mutable[randomIndex]);
        mutable.splice(randomIndex, 1);
      }
      return picked;
    };

    const personalizedPicked = pickFromPool(
      personalizedPool,
      Math.min(limit, Math.max(6, Math.floor(limit * 0.75))),
      5,
    );

    const usedIds = new Set(personalizedPicked.map((entry) => String(entry.post?._id)));
    const fallbackSource = fallbackPool
      .concat(
        personalizedPool.filter((entry) => !usedIds.has(String(entry.post?._id)))
      )
      .filter((entry) => !usedIds.has(String(entry.post?._id)));
    const fallbackPicked = pickFromPool(fallbackSource, Math.max(0, limit - personalizedPicked.length), 10);

    const merged = personalizedPicked.concat(fallbackPicked).slice(0, limit);
    const posts = merged.map((entry) => serializePost(entry.post, req.user._id, savedSet));

    const nextCursor =
      candidates.length === candidateLimit && candidates[candidates.length - 1]?.createdAt
        ? new Date(candidates[candidates.length - 1].createdAt).toISOString()
        : null;

    res.json({ posts, nextCursor });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const listTrendingPosts = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 8, 20);
    const hours = Math.min(parseInt(req.query.hours, 10) || 48, 72);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const savedSet = await getSavedSetForUser(req.user._id);

    const buildTrending = (posts) =>
      posts
        .map((post) => {
          const media = Array.isArray(post.media) ? post.media : [];
          const videoMedia = media.find((m) => m?.type === "video" && m?.url);
          if (!videoMedia) return null;

          const likes = Array.isArray(post.likes) ? post.likes.length : 0;
          const comments = typeof post.commentCount === "number" ? post.commentCount : 0;
          const views = Math.max(
            Number(post?.viewCount || 0),
            Number(post?.views || 0),
            Number(post?.playCount || 0),
            Number(videoMedia?.viewCount || 0),
            Number(videoMedia?.views || 0),
            Number(videoMedia?.playCount || 0),
            0,
          );

          const ageHours = Math.max(1, (Date.now() - new Date(post.createdAt).getTime()) / (1000 * 60 * 60));
          const freshness = Math.max(0, 24 - ageHours) * 0.4;
          const score = likes * 5 + views * 2 + comments * 3 + freshness;

          let thumbnail = videoMedia?.thumbnailUrl || videoMedia?.url || media?.[0]?.url || null;
          if (!thumbnail && videoMedia?.publicId) {
            thumbnail = cloudinary.v2.url(videoMedia.publicId, {
              resource_type: "video",
              format: "jpg",
              transformation: [{ width: 640, crop: "scale", start_offset: "0" }],
            });
          }
          if (!thumbnail) return null;

          return {
            post_id: post._id,
            thumbnail,
            authorAvatar: post.author?.avatarUrl || null,
            created_at: post.createdAt,
            views,
            likes,
            score,
            clip: serializePost(post, req.user._id, savedSet),
          };
        })
        .filter((item) => !!item?.thumbnail)
        .sort((a, b) => {
          if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
          if ((b.views || 0) !== (a.views || 0)) return (b.views || 0) - (a.views || 0);
          if ((b.likes || 0) !== (a.likes || 0)) return (b.likes || 0) - (a.likes || 0);
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        })
        .slice(0, limit);

    const baseQuery = {
      visibility: "public",
      isDelete: { $ne: true },
      isDeleted: { $ne: true },
      media: { $elemMatch: { type: "video", url: { $exists: true, $ne: "" } } },
    };

    const recentCandidates = await Post.find({
      ...baseQuery,
      createdAt: { $gte: since },
    })
      .sort({ createdAt: -1 })
      .limit(250)
      .populate("author", "_id name avatarUrl");

    let scored = buildTrending(recentCandidates);

    if (scored.length < Math.min(limit, 6)) {
      const fallbackCandidates = await Post.find(baseQuery)
        .sort({ createdAt: -1 })
        .limit(400)
        .populate("author", "_id name avatarUrl");
      scored = buildTrending(fallbackCandidates);
    }

    res.json({ posts: scored });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const searchClips = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ posts: [] });
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 40);
    const tokens = q
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 3);

    const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const buildFuzzyPatterns = (token) => {
      const patterns = new Set();
      if (!token) return patterns;
      patterns.add(escapeRegex(token));
      if (token.length > 2) {
        for (let i = 0; i < token.length; i += 1) {
          const deleted = token.slice(0, i) + token.slice(i + 1);
          if (deleted.length > 1) patterns.add(escapeRegex(deleted));
          const wildcard = token.slice(0, i) + "." + token.slice(i + 1);
          patterns.add(escapeRegex(wildcard).replace("\\.", "."));
        }
      }
      return patterns;
    };

    const patterns = new Set();
    tokens.forEach((t) => {
      buildFuzzyPatterns(t).forEach((p) => patterns.add(p));
    });
    const regexList = Array.from(patterns).slice(0, 30).map((p) => new RegExp(p, "i"));
    const savedSet = await getSavedSetForUser(req.user._id);

    const captionQuery = regexList.length
      ? { $or: regexList.map((r) => ({ caption: r })) }
      : { caption: new RegExp(escapeRegex(q), "i") };

    const posts = await Post.find({
      ...captionQuery,
      visibility: "public",
      isDelete: { $ne: true },
      isDeleted: { $ne: true },
      media: { $elemMatch: { type: "video", url: { $exists: true, $ne: "" } } },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("author", "_id name avatarUrl isPrivate isVerified verificationType");

    const serialized = posts.map((p) => serializePost(p, req.user._id, savedSet));
    res.json({ posts: serialized });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const listRelatedClips = async (req, res) => {
  try {
    const { postId } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 12, 24);
    const post = await Post.findById(postId).select("_id author tags caption visibility isDelete isDeleted");
    if (!post || post.isDelete || post.isDeleted) return res.status(404).json({ message: "Post not found" });
    if (!(await canViewPost(req.user._id, post))) return res.status(403).json({ message: "Not allowed" });

    const sourceTags = Array.isArray(post.tags) ? post.tags.map(normalizeTag).filter(Boolean).slice(0, 10) : [];
    const captionTokens = extractCaptionTokens(post.caption).slice(0, 5);
    const query = {
      _id: { $ne: post._id },
      visibility: "public",
      isDelete: { $ne: true },
      isDeleted: { $ne: true },
      media: { $elemMatch: { type: "video", url: { $exists: true, $ne: "" } } },
    };

    const optional = [];
    if (sourceTags.length) optional.push({ tags: { $in: sourceTags } });
    if (captionTokens.length) {
      const regex = new RegExp(captionTokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
      optional.push({ caption: regex });
    }
    if (optional.length) query.$or = optional;

    const savedSet = await getSavedSetForUser(req.user._id);
    const candidates = await Post.find(query)
      .sort({ createdAt: -1 })
      .limit(120)
      .populate("author", "_id name avatarUrl isPrivate isVerified verificationType");

    const scored = candidates.map((item) => {
      const tagOverlap = sourceTags.length ? overlapCount(new Set(sourceTags), item.tags) : 0;
      const likes = Array.isArray(item.likes) ? item.likes.length : 0;
      const comments = Number(item.commentCount || 0);
      const views = Number(item.viewCount || item.playCount || 0);
      const recency = Math.max(0, 48 - (Date.now() - new Date(item.createdAt).getTime()) / (1000 * 60 * 60));
      const score = tagOverlap * 6 + likes * 2 + comments * 2 + views * 0.2 + recency * 0.4 + Math.random() * 2;
      return { item, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const posts = scored.slice(0, limit).map((entry) => serializePost(entry.item, req.user._id, savedSet));
    res.json({ posts });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const getPostInsights = async (req, res) => {
  try {
    const { postId } = req.params;
    const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 30, 180));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const post = await Post.findById(postId).select("_id author likes commentCount viewCount playCount createdAt isDelete isDeleted");
    if (!post || post.isDelete || post.isDeleted) return res.status(404).json({ message: "Post not found" });
    if (String(post.author) !== String(req.user._id)) return res.status(403).json({ message: "Not allowed" });

    const [uniqueViewers, savesAggregate, authorPosts] = await Promise.all([
      PostView.countDocuments({ post: post._id }),
      User.aggregate([
        { $match: { "savedPosts.post": post._id } },
        { $project: { _id: 1 } },
        { $count: "total" },
      ]),
      Post.find({
        author: req.user._id,
        isDelete: { $ne: true },
        isDeleted: { $ne: true },
        createdAt: { $gte: since },
      }).select("_id likes commentCount viewCount playCount createdAt"),
    ]);

    const saveCount = Number(savesAggregate?.[0]?.total || 0);
    const likeCount = Array.isArray(post.likes) ? post.likes.length : 0;
    const commentCount = Number(post.commentCount || 0);
    const viewCount = Number(post.viewCount || post.playCount || 0);
    const engagement = likeCount + commentCount + saveCount;
    const engagementRate = viewCount > 0 ? Number(((engagement / viewCount) * 100).toFixed(2)) : 0;

    const totals = authorPosts.reduce(
      (acc, item) => {
        acc.posts += 1;
        acc.likes += Array.isArray(item.likes) ? item.likes.length : 0;
        acc.comments += Number(item.commentCount || 0);
        acc.views += Number(item.viewCount || item.playCount || 0);
        return acc;
      },
      { posts: 0, likes: 0, comments: 0, views: 0 },
    );

    const byDayMap = new Map();
    authorPosts.forEach((item) => {
      const dayKey = new Date(item.createdAt).toISOString().slice(0, 10);
      const current = byDayMap.get(dayKey) || { date: dayKey, posts: 0, views: 0, likes: 0, comments: 0 };
      current.posts += 1;
      current.views += Number(item.viewCount || item.playCount || 0);
      current.likes += Array.isArray(item.likes) ? item.likes.length : 0;
      current.comments += Number(item.commentCount || 0);
      byDayMap.set(dayKey, current);
    });

    const daily = Array.from(byDayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      post: {
        postId: String(post._id),
        createdAt: post.createdAt,
        likeCount,
        commentCount,
        viewCount,
        uniqueViewers,
        saveCount,
        engagementRate,
      },
      creator: {
        days,
        totals,
        averageViewsPerPost: totals.posts > 0 ? Math.round(totals.views / totals.posts) : 0,
      },
      daily,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const listUserPosts = async (req, res) => {
  try {
    const { userId } = req.params;
    const target = await User.findById(userId).select("_id isPrivate");
    if (!target) return res.status(404).json({ message: "User not found" });
    const savedSet = await getSavedSetForUser(req.user._id);
    
    // If target is private and not me, I must be following them to see posts
    if (String(userId) !== String(req.user._id) && target.isPrivate) {
      const followingIds = await getFollowingIds(req.user._id);
      if (!followingIds.has(String(target._id))) {
        return res.status(403).json({ message: "Posts are private" });
      }
    }
    
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const before = req.query.before ? new Date(req.query.before) : null;
    const query = Post.find({
      author: userId,
      isDelete: { $ne: true },
      isDeleted: { $ne: true },
    });
    if (before && !isNaN(before.getTime())) query.where("createdAt").lt(before);
    const posts = await query
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .populate("author", "_id name avatarUrl isPrivate isVerified verificationType");
    const serialized = posts.map((p) => serializePost(p, req.user._id, savedSet));
    const nextCursor = posts.length === limit ? posts[posts.length - 1].createdAt.toISOString() : null;
    res.json({ posts: serialized, nextCursor });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const likePost = async (req, res) => {
  try {
    const { postId } = req.params;
    const post = await Post.findById(postId);
    if (!post || post.isDelete || post.isDeleted) return res.status(404).json({ message: "Post not found" });
    if (!(await canViewPost(req.user._id, post))) return res.status(403).json({ message: "Not allowed" });
    const already = post.likes.some((id) => String(id) === String(req.user._id));
    if (!already) {
      post.likes.push(req.user._id);
      await post.save();
    }
    res.json({ likeCount: post.likes.length, liked: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const unlikePost = async (req, res) => {
  try {
    const { postId } = req.params;
    const post = await Post.findById(postId);
    if (!post || post.isDelete || post.isDeleted) return res.status(404).json({ message: "Post not found" });
    if (!(await canViewPost(req.user._id, post))) return res.status(403).json({ message: "Not allowed" });
    const beforeLength = post.likes.length;
    post.likes = post.likes.filter((id) => String(id) !== String(req.user._id));
    if (post.likes.length !== beforeLength) await post.save();
    res.json({ likeCount: post.likes.length, liked: false });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const deletePost = async (req, res) => {
  try {
    const { postId } = req.params;
    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ message: "Post not found" });
    const authorId = post.author && post.author._id ? post.author._id : post.author;
    if (String(authorId) !== String(req.user._id)) return res.status(403).json({ message: "Not allowed" });
    await post.deleteOne();
    await Comment.deleteMany({ post: post._id }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const listPostComments = async (req, res) => {
  try {
    const { postId } = req.params;
    const commentId = typeof req.query.commentId === "string" ? req.query.commentId.trim() : "";
    const post = await Post.findById(postId)
      .select("author visibility media caption createdAt hideLikeCount commentsDisabled")
      .populate("author", "_id name avatarUrl");
    if (!post || post.isDelete || post.isDeleted) {
      return res.json({
        comments: [],
        nextCursor: null,
        post: { _id: postId, unavailable: true, unavailableReason: 'deleted' },
      });
    }

    if (!(await canViewPost(req.user._id, post))) {
      return res.json({
        comments: [],
        nextCursor: null,
        post: { _id: postId, unavailable: true, unavailableReason: 'private' },
      });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const before = req.query.before ? new Date(req.query.before) : null;

    const query = Comment.find({ post: postId });
    if (before && !isNaN(before.getTime())) query.where("createdAt").lt(before);
    const comments = await query
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("author", "_id name avatarUrl isVerified verificationType")
      .populate({ path: "parent", select: "_id text createdAt author", populate: { path: "author", select: "_id name avatarUrl isVerified verificationType" } })
      .exec();

    const serialized = comments.map(serializeComment);
    let anchorCommentId = null;

    if (commentId) {
      const anchorComment = await Comment.findOne({ _id: commentId, post: postId })
        .populate("author", "_id name avatarUrl isVerified verificationType")
        .populate({ path: "parent", select: "_id text createdAt author", populate: { path: "author", select: "_id name avatarUrl isVerified verificationType" } })
        .exec();
      if (anchorComment) {
        anchorCommentId = String(anchorComment._id);
        const existing = new Set(serialized.map((c) => String(c._id)));
        const parent = anchorComment.parent ? serializeComment(anchorComment.parent) : null;
        if (parent && !existing.has(String(parent._id))) {
          serialized.unshift(parent);
          existing.add(String(parent._id));
        }
        const anchorSerialized = serializeComment(anchorComment);
        if (!existing.has(String(anchorSerialized._id))) {
          serialized.unshift(anchorSerialized);
        }
      }
    }
    const nextCursor = comments.length === limit ? comments[comments.length - 1].createdAt.toISOString() : null;
    const savedSet = await getSavedSetForUser(req.user._id);
      const previewMedia = Array.isArray(post.media) && post.media.length ? post.media[0] : null;
      const mediaList = Array.isArray(post.media) ? post.media : [];
      const postPreview = {
        _id: post._id,
        authorId: post.author?._id || post.author,
        authorName: post.author?.name,
        authorAvatar: post.author?.avatarUrl,
        authorVerified: !!post.author?.isVerified,
        authorVerificationType: post.author?.verificationType || null,
        caption: post.caption,
        media: previewMedia,
        mediaList,
        createdAt: post.createdAt,
        hideLikeCount: !!post.hideLikeCount,
        commentsDisabled: !!post.commentsDisabled,
        savedByMe: savedSet.has(String(post._id)),
      };
    res.json({ comments: serialized, nextCursor, post: postPreview, anchorCommentId });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const addComment = async (req, res) => {
  try {
    const { postId } = req.params;
    const text = typeof req.body.text === "string" ? req.body.text.trim().slice(0, 500) : "";
    if (!text) return res.status(400).json({ message: "Comment cannot be empty" });
    const rawParentId = typeof req.body.parentId === "string" ? req.body.parentId.trim() : "";

    const post = await Post.findById(postId)
      .select("author visibility caption media createdAt commentsDisabled")
      .populate("author", "_id name avatarUrl isVerified verificationType");
    if (!post || post.isDelete || post.isDeleted) return res.status(404).json({ message: "Post not found" });
    if (!(await canViewPost(req.user._id, post))) return res.status(403).json({ message: "Not allowed" });

    const postAuthorId = post.author?._id || post.author;
    if (post.commentsDisabled && String(postAuthorId) !== String(req.user._id)) {
      return res.status(403).json({ message: "Comments are disabled for this post" });
    }

    let parentId = null;
    if (rawParentId) {
      const parentComment = await Comment.findOne({ _id: rawParentId, post: post._id }).select("_id parent");
      if (!parentComment) return res.status(404).json({ message: "Parent comment not found" });
      parentId = parentComment.parent ? parentComment.parent : parentComment._id;
    }

    const comment = await Comment.create({
      post: post._id,
      author: req.user._id,
      text,
      parent: parentId,
    });

    await Post.updateOne({ _id: post._id }, { $inc: { commentCount: 1 } }).catch(() => {});
    await comment.populate([
      { path: "author", select: "_id name avatarUrl isVerified verificationType" },
      { path: "parent", select: "_id author", populate: { path: "author", select: "_id name avatarUrl isVerified verificationType" } },
    ]);

    const mentionMatches = Array.from(new Set((text.match(/@([\w]+)/g) || []).map((token) => token.slice(1).toLowerCase())));
    if (mentionMatches.length) {
      const mentionedUsers = await User.find({ nameLower: { $in: mentionMatches } }).select("_id");
      const eligibleMentionedIds = (await Promise.all(
        mentionedUsers.map(async (mentioned) => {
          if (String(mentioned._id) === String(req.user._id)) return null;
          const allowed = await canViewPost(mentioned._id, post);
          return allowed ? mentioned._id : null;
        })
      )).filter(Boolean);
      if (eligibleMentionedIds.length) {
        const previewMedia = Array.isArray(post.media) && post.media.length ? post.media[0] : null;
        const baseMetadata = {
          commentId: comment._id,
          postId: post._id,
          postOwnerId: post.author?._id || post.author,
          snippet: text.slice(0, 140),
          postPreview: {
            authorId: post.author?._id || post.author,
            authorName: post.author?.name,
            authorAvatar: post.author?.avatarUrl,
            caption: post.caption,
            media: previewMedia,
            createdAt: post.createdAt,
          },
        };
        await Promise.all(
          eligibleMentionedIds.map((mentionedId) =>
            Notification.findOneAndUpdate(
              { user: mentionedId, type: 'comment_mention', 'metadata.commentId': comment._id },
              {
                user: mentionedId,
                actor: req.user._id,
                type: 'comment_mention',
                metadata: { ...baseMetadata, mentionedUserId: mentionedId },
              },
              { upsert: true, setDefaultsOnInsert: true }
            ).catch(() => {})
          )
        );

        // Push mentions (only when recipient is offline)
        try {
          const onlineUsers = getOnlineUsers();
          const senderAvatarUrl = (req.user?.avatarUrl && (String(req.user.avatarUrl).startsWith('http') ? req.user.avatarUrl : null)) || null;

          await Promise.all(
            eligibleMentionedIds.map(async (mentionedId) => {
              const recipientId = String(mentionedId);
              const socketIds = getSocketIdsForUser(recipientId);
              const isOnline = socketIds.length > 0 || onlineUsers.has(recipientId);
              if (isOnline) return;
              const recipient = await User.findById(recipientId).select('pushToken');
              if (!recipient?.pushToken) return;
              await sendPushNotification(
                recipient.pushToken,
                'Mention',
                `${req.user.name || 'Someone'} mentioned you`,
                {
                  type: 'comment_mention',
                  postId: String(post._id),
                  commentId: String(comment._id),
                  senderId: String(req.user._id),
                  senderUsername: req.user.nickname || req.user.name || '',
                  senderAvatarUrl,
                },
                {
                  collapseId: `mention:${String(post._id)}:${recipientId}`,
                  threadId: `mention:${recipientId}`,
                  image: senderAvatarUrl,
                }
              );
            })
          );
        } catch {}
      }
    }

    const populated = comment;
    res.status(201).json({ comment: serializeComment(populated) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const updatePostSettings = async (req, res) => {
  try {
    const { postId } = req.params;
    const post = await Post.findById(postId).select("_id author hideLikeCount commentsDisabled");
    if (!post || post.isDelete || post.isDeleted) return res.status(404).json({ message: "Post not found" });
    const authorId = post.author && post.author._id ? post.author._id : post.author;
    if (String(authorId) !== String(req.user._id)) return res.status(403).json({ message: "Not allowed" });

    if (typeof req.body.hideLikeCount === "boolean") post.hideLikeCount = req.body.hideLikeCount;
    if (typeof req.body.commentsDisabled === "boolean") post.commentsDisabled = req.body.commentsDisabled;
    await post.save();

    return res.json({
      ok: true,
      hideLikeCount: !!post.hideLikeCount,
      commentsDisabled: !!post.commentsDisabled,
    });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

export const deleteComment = async (req, res) => {
  try {
    const { postId, commentId } = req.params;
    const comment = await Comment.findOne({ _id: commentId, post: postId }).populate("author", "_id");
    if (!comment) return res.status(404).json({ message: "Comment not found" });

    const post = await Post.findById(postId).select("author isDelete isDeleted");
    if (!post || post.isDelete || post.isDeleted) return res.status(404).json({ message: "Post not found" });

    const isCommentAuthor = comment.author && String(comment.author._id || comment.author) === String(req.user._id);
    const postAuthorId = post.author && post.author._id ? post.author._id : post.author;
    const isPostOwner = String(postAuthorId) === String(req.user._id);
    if (!isCommentAuthor && !isPostOwner) {
      return res.status(403).json({ message: "Not allowed" });
    }

    const replyResult = await Comment.deleteMany({ parent: comment._id });
    await comment.deleteOne();
    await Post.updateOne(
      { _id: post._id },
      { $inc: { commentCount: -(1 + (replyResult.deletedCount || 0)) } }
    ).catch(() => {});
    res.json({ ok: true, removedReplies: replyResult.deletedCount || 0 });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const trackPostView = async (req, res) => {
  try {
    const { postId } = req.params;
    const viewerId = req.user?._id;
    if (!viewerId) return res.status(401).json({ message: "Unauthorized" });

    const post = await Post.findById(postId).select("_id author visibility viewCount playCount isDelete isDeleted");
    if (!post || post.isDelete || post.isDeleted) return res.status(404).json({ message: "Post not found" });
    if (!(await canViewPost(viewerId, post))) return res.status(403).json({ message: "Not allowed" });

    const now = new Date();
    const cooldownBoundary = new Date(now.getTime() - VIEW_COOLDOWN_MS);
    const existing = await PostView.findOne({ post: post._id, viewer: viewerId }).select("_id lastViewedAt");

    let incremented = false;
    if (!existing) {
      await PostView.create({ post: post._id, viewer: viewerId, lastViewedAt: now });
      incremented = true;
    } else if (!existing.lastViewedAt || existing.lastViewedAt <= cooldownBoundary) {
      existing.lastViewedAt = now;
      await existing.save();
      incremented = true;
    }

    if (incremented) {
      const updated = await Post.findByIdAndUpdate(
        post._id,
        { $inc: { viewCount: 1, playCount: 1 } },
        { new: true, projection: { viewCount: 1, playCount: 1 } },
      );
      return res.json({
        postId: String(post._id),
        counted: true,
        viewCount: Number(updated?.viewCount || 0),
        playCount: Number(updated?.playCount || 0),
      });
    }

    return res.json({
      postId: String(post._id),
      counted: false,
      viewCount: Number(post.viewCount || 0),
      playCount: Number(post.playCount || 0),
    });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

export const savePost = async (req, res) => {
  try {
    const { postId } = req.params;
    const post = await Post.findById(postId).select("_id author visibility media isDelete isDeleted");
    if (!post || post.isDelete || post.isDeleted) return res.status(404).json({ message: "Post not found" });
    if (!(await canViewPost(req.user._id, post))) return res.status(403).json({ message: "Not allowed" });

    const user = await User.findById(req.user._id).select("savedPosts");
    if (!user) return res.status(404).json({ message: "User not found" });
    const already = Array.isArray(user.savedPosts) && user.savedPosts.some((item) => String(item.post) === String(postId));
    if (!already) {
      user.savedPosts.unshift({ post: post._id, savedAt: new Date() });
      await user.save();
    }
    res.json({ saved: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const unsavePost = async (req, res) => {
  try {
    const { postId } = req.params;
    await User.updateOne(
      { _id: req.user._id },
      { $pull: { savedPosts: { post: postId } } },
    ).catch(() => {});
    res.json({ saved: false });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const listSavedPosts = async (req, res) => {
  try {
    const type = String(req.query.type || "all").toLowerCase();
    const user = await User.findById(req.user._id).select("savedPosts");
    const savedEntries = Array.isArray(user?.savedPosts) ? user.savedPosts : [];
    if (!savedEntries.length) return res.json({ posts: [] });

    const ids = savedEntries.map((item) => item.post).filter(Boolean);
    const posts = await Post.find({
      _id: { $in: ids },
      isDelete: { $ne: true },
      isDeleted: { $ne: true },
    })
      .populate("author", "_id name avatarUrl isPrivate isVerified verificationType");

    for (const post of posts) {
      // eslint-disable-next-line no-await-in-loop
      await ensureVideoThumbnail(post);
    }

    const byId = new Map(posts.map((p) => [String(p._id), p]));
    const savedSet = new Set(ids.map((id) => String(id)));

    const ordered = [];
    const sortedEntries = savedEntries
      .slice()
      .sort((a, b) => new Date(b.savedAt || 0) - new Date(a.savedAt || 0));

    for (const entry of sortedEntries) {
      const post = byId.get(String(entry.post));
      if (!post) continue;
      if (type === "clips" && !isVideoPost(post)) continue;
      // Ensure the viewer can still access the post (e.g., privacy changes).
      // eslint-disable-next-line no-await-in-loop
      const allowed = await canViewPost(req.user._id, post);
      if (!allowed) continue;
      const serialized = serializePost(post, req.user._id, savedSet);
      ordered.push({ ...serialized, savedAt: entry.savedAt });
    }

    res.json({ posts: ordered });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};
