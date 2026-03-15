import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";
import { Expo } from "expo-server-sdk";
import User from "../models/user.model.js";
import NotificationEvent from "../models/notificationEvent.model.js";

const expo = new Expo();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../../..");

let firebaseApp = null;
let firebaseInitAttempted = false;

function getFirebaseCredentialCandidates() {
  const envCandidates = [
    process.env.FIREBASE_SERVICE_ACCOUNT_FILE,
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
  ].filter(Boolean);

  const localCandidates = [
    path.join(projectRoot, "Backend", "firebase-service-account.json"),
    path.join(projectRoot, "Frontend", "google-services-service-account.json"),
    path.join(projectRoot, "Frontend", "snaply-154cb-681fe2635a77.json"),
  ];

  return [...envCandidates, ...localCandidates];
}

function resolveExistingCredentialPath() {
  for (const candidate of getFirebaseCredentialCandidates()) {
    const absolutePath = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(projectRoot, candidate);
    if (fs.existsSync(absolutePath)) {
      return absolutePath;
    }
  }
  return null;
}

function getFirebaseMessaging() {
  if (firebaseApp) {
    return admin.messaging(firebaseApp);
  }
  if (firebaseInitAttempted) {
    return null;
  }

  firebaseInitAttempted = true;

  try {
    const credentialPath = resolveExistingCredentialPath();
    if (!credentialPath) {
      console.warn("[push] Firebase service account file not found; FCM push disabled");
      return null;
    }

    const serviceAccount = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
    firebaseApp = admin.apps[0] || admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log(`[push] Firebase Admin initialized from ${credentialPath}`);
    return admin.messaging(firebaseApp);
  } catch (error) {
    console.error("[push] Failed to initialize Firebase Admin", error);
    return null;
  }
}

function normalizeData(data = {}) {
  const merged = { ...data };
  if (merged.senderUsername && !merged.senderName) {
    merged.senderName = merged.senderUsername;
  }
  if (merged.senderAvatarUrl && !merged.avatarUrl) {
    merged.avatarUrl = merged.senderAvatarUrl;
  }

  return Object.entries(merged).reduce((acc, [key, value]) => {
    if (value === undefined || value === null) return acc;
    if (typeof value === "string") {
      acc[key] = value;
      return acc;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      acc[key] = String(value);
      return acc;
    }
    try {
      acc[key] = JSON.stringify(value);
    } catch {
      acc[key] = String(value);
    }
    return acc;
  }, {});
}

function getTokenSuffix(pushToken) {
  return typeof pushToken === "string" ? pushToken.slice(-12) : null;
}

function isInvalidTokenErrorCode(code = "") {
  const normalized = String(code || "").toLowerCase();
  return (
    normalized.includes("device") && normalized.includes("not") && normalized.includes("registered")
  ) || normalized.includes("registration-token-not-registered");
}

function getAnalyticsPayload(options = {}) {
  const analytics = options?.analytics;
  if (!analytics?.recipientUserId) return null;
  return {
    recipientUserId: String(analytics.recipientUserId),
    notificationType: typeof analytics.notificationType === "string" ? analytics.notificationType : null,
    source: typeof analytics.source === "string" ? analytics.source : "push",
  };
}

async function recordNotificationEvent(analytics = null, eventType, payload = {}) {
  if (!analytics?.recipientUserId || !eventType) return;
  try {
    await NotificationEvent.create({
      user: analytics.recipientUserId,
      eventType,
      source: analytics.source || "push",
      notificationType: analytics.notificationType || null,
      provider: payload?.provider || null,
      tokenSuffix: payload?.tokenSuffix || null,
      status: payload?.status || null,
      metadata: payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {},
    });
  } catch {}
}

async function cleanupInvalidPushToken(pushToken, recipientUserId = null) {
  if (!pushToken || typeof pushToken !== "string") return;
  const token = pushToken.trim();
  if (!token) return;

  const recipientFilter = recipientUserId ? { _id: recipientUserId } : {};
  await User.updateMany(
    { ...recipientFilter, "pushTokens.token": token },
    { $pull: { pushTokens: { token } } }
  ).catch(() => {});
  await User.updateMany(
    { ...recipientFilter, pushToken: token },
    { $unset: { pushToken: 1, pushTokenUpdatedAt: 1 } }
  ).catch(() => {});
}

async function sendExpoPushNotification(pushToken, title, body, data = {}, options = {}) {
  const ttlSeconds = 60 * 60 * 24;
  const collapseId = options?.collapseId;
  const threadId = options?.threadId;
  const categoryId = options?.categoryId;
  const image = options?.image;

  const messages = [{
    to: pushToken,
    sound: "default",
    title,
    body,
    data: normalizeData(data),
    priority: "high",
    channelId: "chat-messages",
    ...(collapseId ? { collapseId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(image ? { image } : {}),
    ttl: ttlSeconds,
    expiration: Math.floor(Date.now() / 1000) + ttlSeconds,
  }];

  const chunks = expo.chunkPushNotifications(messages);
  let hadError = false;
  let invalidToken = false;
  let errorMessage = null;
  let errorCode = null;

  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      for (const ticket of ticketChunk) {
        if (ticket.status === "error") {
          hadError = true;
          errorMessage = ticket.message || errorMessage;
          errorCode = ticket?.details?.error || errorCode;
          if (isInvalidTokenErrorCode(ticket?.details?.error)) {
            invalidToken = true;
          }
          console.error("[push] Expo ticket error", {
            message: ticket.message,
            details: ticket.details,
          });
        }
      }
    } catch (error) {
      hadError = true;
      errorMessage = error?.message || errorMessage;
      errorCode = error?.code || errorCode;
      if (isInvalidTokenErrorCode(error?.code)) {
        invalidToken = true;
      }
      console.error("[push] Error sending Expo push chunk", error);
    }
  }

  return {
    ok: !hadError,
    provider: "expo",
    invalidToken,
    errorCode,
    errorMessage,
  };
}

async function sendFcmPushNotification(pushToken, title, body, data = {}, options = {}) {
  const messaging = getFirebaseMessaging();
  if (!messaging) {
    return {
      ok: false,
      provider: "fcm",
      invalidToken: false,
      errorCode: "messaging_unavailable",
      errorMessage: "Firebase messaging is not configured",
    };
  }

  const ttlMilliseconds = 60 * 60 * 24 * 1000;
  const collapseId = options?.collapseId;
  const threadId = options?.threadId;
  const categoryId = options?.categoryId;
  const image = options?.image;

  const message = {
    token: pushToken,
    notification: {
      title,
      body,
      ...(image ? { imageUrl: image } : {}),
    },
    data: normalizeData({
      ...data,
      ...(categoryId ? { categoryId } : {}),
    }),
    android: {
      priority: "high",
      ttl: ttlMilliseconds,
      collapseKey: collapseId || undefined,
      notification: {
        channelId: "chat-messages",
        sound: "default",
        ...(threadId ? { tag: threadId } : {}),
        ...(image ? { imageUrl: image } : {}),
      },
    },
    apns: {
      headers: {
        "apns-priority": "10",
        ...(collapseId ? { "apns-collapse-id": collapseId } : {}),
      },
      payload: {
        aps: {
          sound: "default",
          "content-available": 1,
          ...(threadId ? { "thread-id": threadId } : {}),
          ...(categoryId ? { category: categoryId } : {}),
        },
      },
      ...(image ? { fcmOptions: { imageUrl: image } } : {}),
    },
  };

  try {
    await messaging.send(message);
    return {
      ok: true,
      provider: "fcm",
      invalidToken: false,
      errorCode: null,
      errorMessage: null,
    };
  } catch (error) {
    const invalidToken = isInvalidTokenErrorCode(error?.code);
    console.error("[push] Error sending FCM push notification", {
      code: error?.code,
      message: error?.message,
    });
    return {
      ok: false,
      provider: "fcm",
      invalidToken,
      errorCode: error?.code || null,
      errorMessage: error?.message || null,
    };
  }
}

export const sendPushNotification = async (pushToken, title, body, data = {}, options = {}) => {
  if (!pushToken || typeof pushToken !== "string") {
    return { ok: false, provider: "unknown", invalidToken: false, errorCode: "invalid_token", errorMessage: "Missing token" };
  }

  const analytics = getAnalyticsPayload(options);
  const tokenSuffix = getTokenSuffix(pushToken);
  const provider = Expo.isExpoPushToken(pushToken) ? "expo" : "fcm";
  await recordNotificationEvent(analytics, "sent", {
    provider,
    tokenSuffix,
    status: "queued",
  });

  try {
    let result;
    if (Expo.isExpoPushToken(pushToken)) {
      result = await sendExpoPushNotification(pushToken, title, body, data, options);
    } else {
      result = await sendFcmPushNotification(pushToken, title, body, data, options);
    }

    if (result?.invalidToken) {
      await cleanupInvalidPushToken(pushToken, analytics?.recipientUserId || null);
    }

    await recordNotificationEvent(analytics, result?.ok ? "provider_accepted" : "delivery_failed", {
      provider: result?.provider || provider,
      tokenSuffix,
      status: result?.ok ? "ok" : (result?.errorCode || "error"),
      metadata: result?.ok
        ? {}
        : {
            errorCode: result?.errorCode || null,
            errorMessage: result?.errorMessage || null,
            invalidToken: !!result?.invalidToken,
          },
    });
    return result;
  } catch (error) {
    console.error("[push] Error sending push notification", error);
    await recordNotificationEvent(analytics, "delivery_failed", {
      provider,
      tokenSuffix,
      status: error?.code || "exception",
      metadata: {
        errorCode: error?.code || null,
        errorMessage: error?.message || null,
      },
    });
    return {
      ok: false,
      provider,
      invalidToken: isInvalidTokenErrorCode(error?.code),
      errorCode: error?.code || null,
      errorMessage: error?.message || null,
    };
  }
};
