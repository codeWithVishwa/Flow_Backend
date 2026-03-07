import cloudinary from "cloudinary";
import Day from "../models/day.model.js";
import User from "../models/user.model.js";

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

function uploadBuffer(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.v2.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    stream.end(buffer);
  });
}

export const createDay = async (req, res) => {
  try {
    ensureCloudinaryConfigured();
    if (!req.file) return res.status(400).json({ message: "No file provided" });

    const isVideo = req.file.mimetype.startsWith("video/");
    const resourceType = isVideo ? "video" : "image";
    const folder = `flowsnap/days/${req.user._id}`;
    
    const result = await uploadBuffer(req.file.buffer, {
      folder,
      resource_type: resourceType,
      overwrite: false,
    });

    // Max duration for video days? Let's say 60s
    if (isVideo && result.duration && result.duration > 60) {
      await cloudinary.v2.uploader.destroy(result.public_id, { resource_type: "video" }).catch(() => {});
      return res.status(400).json({ message: "Video days must be under 60 seconds." });
    }

    const day = await Day.create({
      author: req.user._id,
      media: {
        url: result.secure_url,
        type: resourceType,
        publicId: result.public_id,
        durationSeconds: result.duration ? Math.round(result.duration) : undefined,
      },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
    });

    res.status(201).json({ day });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const listFeedDays = async (req, res) => {
  try {
    // Get users I follow
    const user = await User.findById(req.user._id).select("following");
    const followingIds = user.following.map(id => String(id));
    
    // Include myself
    const targetIds = [...followingIds, String(req.user._id)];

    // Find active days from these users
    const days = await Day.find({
      author: { $in: targetIds },
      expiresAt: { $gt: new Date() }
    })
    .sort({ createdAt: 1 }) // Oldest first within the 24h window? Or newest? Usually stories are chronological.
    .populate("author", "_id name avatarUrl isVerified verificationType");

    // Group by user
    const grouped = {};
    days.forEach(day => {
      const authorId = String(day.author._id);
      if (!grouped[authorId]) {
        grouped[authorId] = {
          user: day.author,
          days: [],
          hasUnviewed: false,
          latestDate: day.createdAt
        };
      }
      
      const viewed = day.viewers.some(v => String(v) === String(req.user._id));
      if (!viewed) grouped[authorId].hasUnviewed = true;
      if (day.createdAt > grouped[authorId].latestDate) grouped[authorId].latestDate = day.createdAt;

      grouped[authorId].days.push({
        _id: day._id,
        media: day.media,
        createdAt: day.createdAt,
        expiresAt: day.expiresAt,
        viewed
      });
    });

    // Convert to array and sort
    // Sort order: 
    // 1. My own story (if exists)
    // 2. Users with unviewed stories (sorted by latest update)
    // 3. Users with all viewed stories (sorted by latest update)
    
    let result = Object.values(grouped);
    
    result.sort((a, b) => {
      const aIsMe = String(a.user._id) === String(req.user._id);
      const bIsMe = String(b.user._id) === String(req.user._id);
      if (aIsMe) return -1;
      if (bIsMe) return 1;

      if (a.hasUnviewed && !b.hasUnviewed) return -1;
      if (!a.hasUnviewed && b.hasUnviewed) return 1;

      return new Date(b.latestDate) - new Date(a.latestDate);
    });

    res.json({ feed: result });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const viewDay = async (req, res) => {
  try {
    const { dayId } = req.params;
    const day = await Day.findById(dayId);
    if (!day) return res.status(404).json({ message: "Day not found" });

    // Add to viewers if not already there
    if (!day.viewers.includes(req.user._id)) {
      day.viewers.push(req.user._id);
      await day.save();
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const deleteDay = async (req, res) => {
  try {
    const { dayId } = req.params;
    const day = await Day.findById(dayId);
    if (!day) return res.status(404).json({ message: "Day not found" });

    if (String(day.author) !== String(req.user._id)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Delete from cloudinary
    if (day.media && day.media.publicId) {
      const type = day.media.type === 'video' ? 'video' : 'image';
      await cloudinary.v2.uploader.destroy(day.media.publicId, { resource_type: type }).catch(() => {});
    }

    await day.deleteOne();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};
