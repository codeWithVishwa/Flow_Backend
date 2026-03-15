function normalizeToken(value) {
  if (typeof value !== "string") return null;
  const token = value.trim();
  return token || null;
}

export function listPushTokensFromUser(user = null) {
  const tokens = [];
  const seen = new Set();

  const addToken = (rawToken) => {
    const token = normalizeToken(rawToken);
    if (!token || seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };

  addToken(user?.pushToken);
  const records = Array.isArray(user?.pushTokens) ? user.pushTokens : [];
  records.forEach((entry) => {
    if (entry?.disabledAt) return;
    addToken(entry?.token);
  });

  return tokens;
}

function toPlainRecord(entry) {
  if (!entry) return null;
  if (typeof entry.toObject === "function") {
    return entry.toObject();
  }
  return { ...entry };
}

export function upsertPushTokenRecord(records = [], payload = {}) {
  const token = normalizeToken(payload?.token);
  if (!token) return Array.isArray(records) ? records : [];

  const now = payload?.updatedAt instanceof Date ? payload.updatedAt : new Date();
  const provider =
    typeof payload?.provider === "string" && payload.provider.trim()
      ? payload.provider.trim().slice(0, 24)
      : "unknown";
  const platform =
    typeof payload?.platform === "string" && payload.platform.trim()
      ? payload.platform.trim().slice(0, 24)
      : null;
  const deviceId =
    typeof payload?.deviceId === "string" && payload.deviceId.trim()
      ? payload.deviceId.trim().slice(0, 120)
      : null;
  const appVersion =
    typeof payload?.appVersion === "string" && payload.appVersion.trim()
      ? payload.appVersion.trim().slice(0, 40)
      : null;

  const next = (Array.isArray(records) ? records : [])
    .map((entry) => toPlainRecord(entry))
    .filter(Boolean);

  const existingIndex = next.findIndex((entry) => normalizeToken(entry?.token) === token);
  const patch = {
    token,
    provider,
    platform,
    deviceId,
    appVersion,
    updatedAt: now,
    disabledAt: null,
  };

  if (existingIndex >= 0) {
    next[existingIndex] = {
      ...next[existingIndex],
      ...patch,
      createdAt: next[existingIndex]?.createdAt || now,
    };
  } else {
    next.push({ ...patch, createdAt: now });
  }

  // Keep the most recently updated token first.
  next.sort((a, b) => {
    const aTs = new Date(a?.updatedAt || 0).getTime();
    const bTs = new Date(b?.updatedAt || 0).getTime();
    return bTs - aTs;
  });

  return next;
}
