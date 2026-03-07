import express from "express";
import auth from "../middleware/auth.js";
import { uploadMedia } from "../middleware/upload.js";
import { uploadSignatureLimiter, createPostLimiter } from "../middleware/rateLimit.js";
import {
  createPost,
  addComment,
  deleteComment,
  deletePost,
  likePost,
  listPostComments,
  listFeedPosts,
  listUserPosts,
  listTrendingPosts,
  searchClips,
  listRelatedClips,
  getPostInsights,
  unlikePost,
  trackPostView,
  uploadPostMedia,
  generateVideoUploadSignature,
  updatePostSettings,
  savePost,
  unsavePost,
  listSavedPosts,
} from "../controllers/posts.controller.js";

const router = express.Router();

router.post("/video/signature", auth, uploadSignatureLimiter, generateVideoUploadSignature);
router.post("/media", auth, uploadMedia.single("media"), uploadPostMedia);
router.post("/", auth, createPostLimiter, createPost);
router.get("/feed", auth, listFeedPosts);
router.get("/trending", auth, listTrendingPosts);
router.get("/search-clips", auth, searchClips);
router.get("/:postId/related", auth, listRelatedClips);
router.get("/:postId/insights", auth, getPostInsights);
router.get("/saved", auth, listSavedPosts);
router.get("/user/:userId", auth, listUserPosts);
router.post("/:postId/like", auth, likePost);
router.delete("/:postId/like", auth, unlikePost);
router.post("/:postId/view", auth, trackPostView);
router.post("/:postId/save", auth, savePost);
router.delete("/:postId/save", auth, unsavePost);
router.get("/:postId/comments", auth, listPostComments);
router.post("/:postId/comments", auth, addComment);
router.delete("/:postId/comments/:commentId", auth, deleteComment);
router.patch("/:postId/settings", auth, updatePostSettings);
router.delete("/:postId", auth, deletePost);

export default router;
