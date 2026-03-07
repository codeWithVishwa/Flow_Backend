import express from "express";
import { getClientConfig } from "../controllers/system.controller.js";

const router = express.Router();

router.get("/config", getClientConfig);

export default router;
