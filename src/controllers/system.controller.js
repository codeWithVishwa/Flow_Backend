import AppConfig from "../models/appConfig.model.js";

const CLIENT_CONFIG_KEY = "client_config_v1";

const DEFAULT_FEATURE_FLAGS = {
  premiumUploadUI: true,
  enableNearbyUsersTab: true,
  enableTypingIndicator: true,
  enablePostRecommendations: true,
  enableClipRecommendations: true,
  enableCreatorInsights: true,
};

function parseEnvBoolean(value, fallback) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function getEnvFeatureOverrides() {
  return {
    premiumUploadUI: parseEnvBoolean(process.env.FEATURE_PREMIUM_UPLOAD_UI, DEFAULT_FEATURE_FLAGS.premiumUploadUI),
    enableNearbyUsersTab: parseEnvBoolean(process.env.FEATURE_NEARBY_USERS_TAB, DEFAULT_FEATURE_FLAGS.enableNearbyUsersTab),
    enableTypingIndicator: parseEnvBoolean(process.env.FEATURE_TYPING_INDICATOR, DEFAULT_FEATURE_FLAGS.enableTypingIndicator),
    enablePostRecommendations: parseEnvBoolean(process.env.FEATURE_POST_RECOMMENDATIONS, DEFAULT_FEATURE_FLAGS.enablePostRecommendations),
    enableClipRecommendations: parseEnvBoolean(process.env.FEATURE_CLIP_RECOMMENDATIONS, DEFAULT_FEATURE_FLAGS.enableClipRecommendations),
    enableCreatorInsights: parseEnvBoolean(process.env.FEATURE_CREATOR_INSIGHTS, DEFAULT_FEATURE_FLAGS.enableCreatorInsights),
  };
}

function buildDefaultConfig() {
  return {
    featureFlags: {
      ...DEFAULT_FEATURE_FLAGS,
      ...getEnvFeatureOverrides(),
    },
    upload: {
      maxVideoSeconds: 20,
      maxVideoMegabytes: 20,
      allowedVideoFormats: ["mp4"],
    },
    feed: {
      suggestedProfilesCadence: [2, 30],
    },
    updatedAt: new Date().toISOString(),
  };
}

export const getClientConfig = async (_req, res) => {
  try {
    const doc = await AppConfig.findOne({ key: CLIENT_CONFIG_KEY }).lean();
    const defaults = buildDefaultConfig();
    const merged = {
      ...defaults,
      ...(doc?.value && typeof doc.value === "object" ? doc.value : {}),
      featureFlags: {
        ...defaults.featureFlags,
        ...(doc?.value?.featureFlags || {}),
      },
      updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : defaults.updatedAt,
    };
    res.json({ config: merged });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};
