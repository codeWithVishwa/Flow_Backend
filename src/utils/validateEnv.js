export function validateEnv() {
  const required = [
    "MONGO_URI",
    "JWT_SECRET",
    "APP_BASE_URL",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.warn("[env] Missing required variables:", missing.join(", "));
  }

  // Recommended for browser/web auth (cookie-based refresh tokens)
  if (!process.env.JWT_REFRESH_SECRET) {
    console.warn("[env] JWT_REFRESH_SECRET is not set (recommended for web refresh tokens). Falling back to JWT_SECRET.");
  }

  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
    console.warn("[env] JWT_SECRET appears weak (<32 chars). Use a long random secret.");
  }

  if ((process.env.NODE_ENV || "").toLowerCase() === "production" && !process.env.FRONTEND_URL) {
    console.warn("[env] FRONTEND_URL is not set in production. CORS will be harder to control safely.");
  }
}
