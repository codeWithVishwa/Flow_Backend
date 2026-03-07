import express from "express";
import auth from "../middleware/auth.js";
import { uploadMedia } from "../middleware/upload.js";
import { createDay, listFeedDays, viewDay, deleteDay } from "../controllers/days.controller.js";

const router = express.Router();

router.post("/", auth, uploadMedia.single("file"), createDay);
router.get("/feed", auth, listFeedDays);
router.post("/:dayId/view", auth, viewDay);
router.delete("/:dayId", auth, deleteDay);

export default router;
