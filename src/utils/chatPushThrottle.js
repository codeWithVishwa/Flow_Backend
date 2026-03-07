import ChatPushThrottle from "../models/chatPushThrottle.model.js";

const DEFAULT_WINDOW_MS = 15_000;

function getThrottleWindowMs() {
  const raw = process.env.PUSH_CHAT_THROTTLE_MS;
  const n = raw ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WINDOW_MS;
  return n;
}

/**
 * Decides whether to send a push for a chat message.
 * If pushes were suppressed since the last sent push, returns that count so the caller
 * can include it in the body/title (Instagram-like: "N new messages").
 */
export async function decideChatPush({ userId, fromUserId, conversationId, previewText }) {
  const windowMs = getThrottleWindowMs();
  const now = new Date();

  const key = {
    userId,
    fromUserId,
    conversationId,
  };

  const existing = await ChatPushThrottle.findOne(key)
    .select("lastSentAt suppressedCount")
    .lean();

  const lastSentAt = existing?.lastSentAt ? new Date(existing.lastSentAt) : null;
  const suppressedCount = existing?.suppressedCount || 0;

  if (lastSentAt && windowMs > 0 && now - lastSentAt < windowMs) {
    await ChatPushThrottle.updateOne(
      key,
      {
        $set: { lastEventAt: now, lastPreviewText: previewText },
        $inc: { suppressedCount: 1 },
      },
      { upsert: true }
    );
    return { send: false, suppressedSinceLastSend: suppressedCount + 1 };
  }

  // We will send a push now; reset suppression counter.
  await ChatPushThrottle.updateOne(
    key,
    {
      $set: {
        lastSentAt: now,
        lastEventAt: now,
        lastPreviewText: previewText,
        suppressedCount: 0,
      },
    },
    { upsert: true }
  );

  return { send: true, suppressedSinceLastSend: suppressedCount };
}
