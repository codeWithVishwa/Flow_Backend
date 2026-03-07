import express from "express";
import adminAuth from "../middleware/adminAuth.js";
import {
  adminLogin,
  adminLogout,
  adminMe,
  getStats,
  getAllUsers,
  getUserById,
  banUser,
  suspendUser,
  unbanUser,
  verifyUser,
  revokeVerification,
  getUserSessions,
  revokeUserSession,
  revokeAllUserSessions,
  getAllPosts,
  getPostById,
  getCommentsForPost,
  deleteComment,
  softDeletePost,
  deletePost,
  getAllReports,
  getLatestReport,
  getReportById,
  setReportFlag,
  addReportNote,
  resolveReport,
  getClientConfig,
  updateClientConfig,
  getCreatorLeaderboard,
  getCreatorInsights,
  getAdminNotifications,
  createAdminNotification,
  getAuditLogs,
} from "../controllers/admin.controller.js";

const router = express.Router();

router.post("/login", adminLogin);
router.post("/logout", adminLogout);

router.use(adminAuth);

router.get("/me", adminMe);
router.get("/stats", getStats);
router.get("/audit-logs", getAuditLogs);
router.get("/notifications", getAdminNotifications);
router.post("/notifications", createAdminNotification);

router.get("/config/client", getClientConfig);
router.patch("/config/client", updateClientConfig);
router.get("/insights/creators", getCreatorLeaderboard);
router.get("/insights/creators/:userId", getCreatorInsights);

router.get("/users", getAllUsers);
router.get("/users/:id", getUserById);
router.post("/users/:id/ban", banUser);
router.post("/users/:id/suspend", suspendUser);
router.post("/users/:id/unban", unbanUser);
router.post("/verify-user", verifyUser);
router.post("/revoke-verification", revokeVerification);
router.get("/users/:id/sessions", getUserSessions);
router.delete("/users/:id/sessions/:sessionId", revokeUserSession);
router.post("/users/:id/sessions/revoke-all", revokeAllUserSessions);

router.get("/posts", getAllPosts);
router.get("/posts/:id", getPostById);
router.get("/posts/:id/comments", getCommentsForPost);
router.post("/posts/:id/soft-delete", softDeletePost);
router.delete("/posts/:id", deletePost);
router.delete("/comments/:id", deleteComment);

router.get("/reports", getAllReports);
router.get("/reports/latest", getLatestReport);
router.get("/reports/:id", getReportById);
router.post("/reports/:id/flag", setReportFlag);
router.post("/reports/:id/notes", addReportNote);
router.post("/reports/:id/resolve", resolveReport);

export default router;
