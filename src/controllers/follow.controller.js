import User from "../models/user.model.js";
import Notification from "../models/notification.model.js";
import { sendPushNotification } from "../utils/expoPush.js";
import { getIO, getOnlineUsers, getSocketIdsForUser } from "../socket.js";

function toAbsoluteUrl(url) {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = process.env.APP_BASE_URL || process.env.BASE_URL;
  if (!base) return url;
  return `${String(base).replace(/\/$/, "")}/${url.replace(/^\//, "")}`;
}

function idsEqual(a, b) {
  return String(a) === String(b);
}

function listIncludes(list, id) {
  return Array.isArray(list) && list.some((entry) => idsEqual(entry, id));
}

function ensureOwnership(reqUserId, targetId) {
  if (!idsEqual(reqUserId, targetId)) {
    const err = new Error("Not authorized to manage these requests");
    err.statusCode = 403;
    throw err;
  }
}

async function ensureUsers(meId, targetId) {
  const [me, target] = await Promise.all([
    User.findById(meId).select("blockedUsers following"),
    User.findById(targetId).select("blockedUsers followers followRequests isPrivate messageRequests"),
  ]);
  if (!target) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }
  if (!me) {
    const err = new Error("Viewer not found");
    err.statusCode = 404;
    throw err;
  }
  if (listIncludes(me.blockedUsers, targetId)) {
    const err = new Error("Unblock this user before following");
    err.statusCode = 403;
    throw err;
  }
  if (listIncludes(target.blockedUsers, meId)) {
    const err = new Error("This user has blocked you");
    err.statusCode = 403;
    throw err;
  }
  return { me, target };
}

export const followUser = async (req, res) => {
  try {
    const { targetUserId } = req.params;
    if (idsEqual(targetUserId, req.user._id)) {
      return res.status(400).json({ message: "Cannot follow yourself" });
    }
    const { target } = await ensureUsers(req.user._id, targetUserId);

    if (listIncludes(target.followers, req.user._id)) {
      return res.json({ status: "already_following" });
    }

    if (target.isPrivate) {
      if (!listIncludes(target.followRequests, req.user._id)) {
        target.followRequests.push(req.user._id);
        await target.save();
      }

      // Persist + push: follow request
      Notification.findOneAndUpdate(
        { user: targetUserId, type: "follow_request", actor: req.user._id },
        {
          user: targetUserId,
          actor: req.user._id,
          type: "follow_request",
          metadata: {
            message: `${req.user.name || "Someone"} requested to follow you`,
          },
          readAt: null,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).catch(() => {});

      // Realtime in-app notification refresh for recipient
      try {
        const io = getIO();
        io.to(`user:${String(targetUserId)}`).emit("notify:update", {
          type: "follow_request",
          actorId: String(req.user._id),
          actorName: req.user?.name || req.user?.nickname || "Someone",
          actorAvatarUrl: toAbsoluteUrl(req.user?.avatarUrl) || null,
          message: `${req.user.name || "Someone"} requested to follow you`,
          createdAt: new Date().toISOString(),
        });
      } catch {}

      try {
        const recipientId = String(targetUserId);
        const onlineUsers = getOnlineUsers();
        const socketIds = getSocketIdsForUser(recipientId);
        const isOnline = socketIds.length > 0 || onlineUsers.has(recipientId);

        if (!isOnline) {
          const recipient = await User.findById(recipientId).select("pushToken");
          if (recipient?.pushToken) {
            const senderAvatarUrl = toAbsoluteUrl(req.user.avatarUrl) || null;
            await sendPushNotification(
              recipient.pushToken,
              "Follow request",
              `${req.user.name || "Someone"} requested to follow you`,
              {
                type: "follow_request",
                senderId: String(req.user._id),
                senderUsername: req.user.nickname || req.user.name || "",
                senderAvatarUrl,
              },
              {
                collapseId: `followreq:${recipientId}:${String(req.user._id)}`,
                threadId: `followreq:${recipientId}`,
                image: senderAvatarUrl,
              }
            );
          }
        }
      } catch {}

      return res.json({ status: "requested" });
    }

    await Promise.all([
      User.findByIdAndUpdate(req.user._id, { $addToSet: { following: targetUserId } }),
      User.findByIdAndUpdate(targetUserId, {
        $addToSet: { followers: req.user._id },
        $pull: { followRequests: req.user._id },
      }),
    ]);

    // Persist + push: follow
    Notification.findOneAndUpdate(
      { user: targetUserId, type: "follow", actor: req.user._id },
      {
        user: targetUserId,
        actor: req.user._id,
        type: "follow",
        metadata: {
          message: `${req.user.name || "Someone"} started following you`,
        },
        readAt: null,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).catch(() => {});

    // Realtime in-app notification refresh for recipient
    try {
      const io = getIO();
      io.to(`user:${String(targetUserId)}`).emit("notify:update", {
        type: "follow",
        actorId: String(req.user._id),
        actorName: req.user?.name || req.user?.nickname || "Someone",
        actorAvatarUrl: toAbsoluteUrl(req.user?.avatarUrl) || null,
        message: `${req.user.name || "Someone"} started following you`,
        createdAt: new Date().toISOString(),
      });
    } catch {}

    try {
      const recipientId = String(targetUserId);
      const onlineUsers = getOnlineUsers();
      const socketIds = getSocketIdsForUser(recipientId);
      const isOnline = socketIds.length > 0 || onlineUsers.has(recipientId);

      if (!isOnline) {
        const recipient = await User.findById(recipientId).select("pushToken");
        if (recipient?.pushToken) {
          const senderAvatarUrl = toAbsoluteUrl(req.user.avatarUrl) || null;
          await sendPushNotification(
            recipient.pushToken,
            "New follower",
            `${req.user.name || "Someone"} started following you`,
            {
              type: "follow",
              senderId: String(req.user._id),
              senderUsername: req.user.nickname || req.user.name || "",
              senderAvatarUrl,
            },
            {
              collapseId: `follow:${recipientId}:${String(req.user._id)}`,
              threadId: `follow:${recipientId}`,
              image: senderAvatarUrl,
            }
          );
        }
      }
    } catch {}

    return res.json({ status: "following" });
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
};

export const unfollowUser = async (req, res) => {
  try {
    const { targetUserId } = req.params;
    if (idsEqual(targetUserId, req.user._id)) {
      return res.status(400).json({ message: "Cannot unfollow yourself" });
    }
    await Promise.all([
      User.findByIdAndUpdate(req.user._id, { $pull: { following: targetUserId } }),
      User.findByIdAndUpdate(targetUserId, {
        $pull: { followers: req.user._id, followRequests: req.user._id },
      }),
    ]);
    res.json({ status: "not_following" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const removeFollower = async (req, res) => {
  try {
    const { userId, followerId } = req.params;
    ensureOwnership(req.user._id, userId);
    if (idsEqual(userId, followerId)) {
      return res.status(400).json({ message: "Cannot remove yourself" });
    }

    await Promise.all([
      User.findByIdAndUpdate(userId, {
        $pull: { followers: followerId, followRequests: followerId, following: followerId },
      }),
      User.findByIdAndUpdate(followerId, {
        $pull: { following: userId, followers: userId },
      }),
    ]);

    res.json({ status: "removed" });
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
};

export const getFollowRequests = async (req, res) => {
  try {
    const { userId } = req.params;
    ensureOwnership(req.user._id, userId);
    const user = await User.findById(userId)
      .select("followRequests")
      .populate("followRequests", "name avatarUrl isPrivate");
    res.json({ requests: user?.followRequests || [] });
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
};

export const acceptFollowRequest = async (req, res) => {
  try {
    const { userId, requesterId } = req.params;
    ensureOwnership(req.user._id, userId);
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!listIncludes(user.followRequests, requesterId) && listIncludes(user.followers, requesterId)) {
      return res.json({ status: "already_following" });
    }

    user.followRequests = user.followRequests.filter((id) => !idsEqual(id, requesterId));
    await user.save();

    await Promise.all([
      User.findByIdAndUpdate(requesterId, { $addToSet: { following: userId } }),
      User.findByIdAndUpdate(userId, { $addToSet: { followers: requesterId } }),
    ]);
    res.json({ status: "accepted" });
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
};

export const rejectFollowRequest = async (req, res) => {
  try {
    const { userId, requesterId } = req.params;
    ensureOwnership(req.user._id, userId);
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    const before = user.followRequests.length;
    user.followRequests = user.followRequests.filter((id) => !idsEqual(id, requesterId));
    await user.save();
    if (before === user.followRequests.length) {
      return res.status(404).json({ message: "Request not found" });
    }
    res.json({ status: "rejected" });
  } catch (e) {
    res.status(e.statusCode || 500).json({ message: e.message });
  }
};
