import express from "express";
import auth from "../middleware/auth.js";
import { reportPost, reportUser } from "../controllers/reports.controller.js";

const router = express.Router();

// Create a report for a post (clip)
router.post("/posts/:postId", auth, reportPost);

// Create a report for a user
router.post("/users/:userId", auth, reportUser);

export default router;
