import express from "express";
import auth from "../middleware/auth.js";
import {
	getOrCreateConversation,
	getConversation,
	listConversations,
	listMessages,
	sendMessage,
	markRead,
	deleteMessage,
	deleteConversationForUser,
	clearConversationForUser,
	startChat,
	listMessageRequests,
	acceptMessageRequest,
	rejectMessageRequest,
	uploadChatMedia,
  replyFromNotification,
	createGroupConversation,
	updateGroupConversation,
	addGroupMembers,
	removeGroupMember,
	leaveGroup,
	generateGroupInvite,
	joinGroupByInvite,
	addGroupAdmin,
	removeGroupAdmin,
	listGroupInvites,
	respondGroupInvite,
  favoriteConversation,
  unfavoriteConversation,
} from "../controllers/chat.controller.js";
import { uploadMedia } from "../middleware/upload.js";

const router = express.Router();

// Group chat (place before /conversations/:userId to avoid route clash with "group")
router.post("/conversations/group", auth, createGroupConversation);
router.post("/conversations/group/join/:inviteCode", auth, joinGroupByInvite);
router.patch("/conversations/:conversationId/group", auth, updateGroupConversation);
router.post("/conversations/:conversationId/group/members", auth, addGroupMembers);
router.delete("/conversations/:conversationId/group/members/:memberId", auth, removeGroupMember);
router.post("/conversations/:conversationId/group/admins/:memberId", auth, addGroupAdmin);
router.delete("/conversations/:conversationId/group/admins/:memberId", auth, removeGroupAdmin);
router.post("/conversations/:conversationId/group/leave", auth, leaveGroup);
router.post("/conversations/:conversationId/group/invite", auth, generateGroupInvite);
router.get("/group-invites", auth, listGroupInvites);
router.post("/group-invites/:inviteId/respond", auth, respondGroupInvite);

router.get("/conversations", auth, listConversations);
router.get("/conversations/:conversationId", auth, getConversation);
router.post("/conversations/:conversationId/favorite", auth, favoriteConversation);
router.delete("/conversations/:conversationId/favorite", auth, unfavoriteConversation);
router.post("/conversations/:userId", auth, getOrCreateConversation);
router.get("/conversations/:conversationId/messages", auth, listMessages);
router.post("/conversations/:conversationId/messages", auth, sendMessage);
router.post("/conversations/:conversationId/media", auth, uploadMedia.single("media"), uploadChatMedia);
router.post("/conversations/:conversationId/read", auth, markRead);
router.post("/conversations/:conversationId/clear", auth, clearConversationForUser);
router.delete("/conversations/:conversationId", auth, deleteConversationForUser);
router.delete("/messages/:messageId", auth, deleteMessage);

router.post("/start/:targetUserId", auth, startChat);
router.get("/requests", auth, listMessageRequests);
router.post("/requests/:requesterId/accept", auth, acceptMessageRequest);
router.post("/requests/:requesterId/reject", auth, rejectMessageRequest);

router.post("/reply-from-notification", auth, replyFromNotification);

export default router;
