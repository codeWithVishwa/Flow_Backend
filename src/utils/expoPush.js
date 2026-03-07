import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";
import { Expo } from "expo-server-sdk";

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
  for (const chunk of chunks) {
    try {
      const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
      for (const ticket of ticketChunk) {
        if (ticket.status === "error") {
          console.error("[push] Expo ticket error", {
            message: ticket.message,
            details: ticket.details,
          });
        }
      }
    } catch (error) {
      console.error("[push] Error sending Expo push chunk", error);
    }
  }
}

async function sendFcmPushNotification(pushToken, title, body, data = {}, options = {}) {
  const messaging = getFirebaseMessaging();
  if (!messaging) {
    return;
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
  } catch (error) {
    console.error("[push] Error sending FCM push notification", {
      code: error?.code,
      message: error?.message,
    });
  }
}

export const sendPushNotification = async (pushToken, title, body, data = {}, options = {}) => {
  if (!pushToken || typeof pushToken !== "string") {
    return;
  }

  try {
    if (Expo.isExpoPushToken(pushToken)) {
      await sendExpoPushNotification(pushToken, title, body, data, options);
      return;
    }

    await sendFcmPushNotification(pushToken, title, body, data, options);
  } catch (error) {
    console.error("[push] Error sending push notification", error);
  }
};
