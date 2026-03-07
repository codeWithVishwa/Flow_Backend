import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import helmet from "helmet";
import sanitizeHtml from "sanitize-html";
import connectDB from "./config/db.js";
import http from "http";
import { initSocket } from "./socket.js";
import authRoutes from "./routes/auth.routes.js";
import userRoutes from "./routes/users.routes.js";
import chatRoutes from "./routes/chat.routes.js";
import { apiLimiter } from "./middleware/rateLimit.js";
import { validateEnv } from "./utils/validateEnv.js";
import errorHandler from "./middleware/errorHandler.js";
import postRoutes from "./routes/posts.routes.js";
import dayRoutes from "./routes/days.routes.js";
import reportRoutes from "./routes/reports.routes.js";
import systemRoutes from "./routes/system.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import User from "./models/user.model.js";
// If you kept express-mongo-sanitize and are on an Express-5-safe version, you can import and use it here.
// import mongoSanitize from "express-mongo-sanitize";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Always resolve .env from Backend root (../.env), not from process.cwd().
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
const app = express();
validateEnv();
app.disable("x-powered-by");

// Trust first proxy (Render/Heroku/NGINX) so rate limiting & IP detection works
// This addresses express-rate-limit ValidationError about X-Forwarded-For
app.set('trust proxy', 1);

// CORS
const configuredOrigins = [
  process.env.FRONTEND_URL,
  process.env.ADMIN_DASHBOARD_ORIGIN,
  process.env.APP_BASE_URL,
  'http://localhost:19006', // Expo web dev
  'http://127.0.0.1:19006',
  'http://localhost:5173', // Vite default
  'http://127.0.0.1:5173'
].filter(Boolean);

const normalizeOrigin = (value) => {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.origin;
  } catch {
    return null;
  }
};

const allowedOrigins = new Set(
  configuredOrigins
    .map(normalizeOrigin)
    .filter(Boolean)
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // RN/Expo native requests have no origin
      // Allow any localhost during development
      if (/^https?:\/\/localhost(?::\d+)?$/i.test(origin) || /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin)) {
        return callback(null, true);
      }
      const normalized = normalizeOrigin(origin);
      if (normalized && allowedOrigins.has(normalized)) return callback(null, true);
      // In non-production, be permissive to ease dev
      if (process.env.NODE_ENV !== 'production') return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

// Parse first
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb", parameterLimit: 200 }));
app.use(cookieParser());

// Security headers
app.use(helmet());

// Optional: If you use Mongoose, enable filter sanitization at the ORM layer
// import mongoose from "mongoose";
// mongoose.set("sanitizeFilter", true);

// Optional: If you still use express-mongo-sanitize and it's Express-5 safe, enable it here
// app.use(mongoSanitize());

// In-place XSS sanitizer for inputs (mutates; does not reassign req.query/body/params)
function deepSanitizeInPlace(value) {
  if (typeof value === "string") {
    // Strip all HTML; adjust allowlist if you need certain tags/attrs
    return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} });
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      const sanitized = deepSanitizeInPlace(v);
      if (sanitized !== v) value[i] = sanitized;
    }
    return value;
  }
  if (value && typeof value === "object") {
    for (const k of Object.keys(value)) {
      const v = value[k];
      const sanitized = deepSanitizeInPlace(v);
      if (sanitized !== v) value[k] = sanitized;
    }
    return value;
  }
  return value;
}

// Remove dangerous keys ($ operators / dotted keys) to reduce NoSQL injection risk.
function stripDangerousObjectKeys(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry) => stripDangerousObjectKeys(entry));
    return;
  }
  for (const key of Object.keys(value)) {
    if (key.startsWith("$") || key.includes(".")) {
      delete value[key];
      continue;
    }
    stripDangerousObjectKeys(value[key]);
  }
}

app.use((req, res, next) => {
  // IMPORTANT: only mutate; do not reassign req.query
  deepSanitizeInPlace(req.body);
  deepSanitizeInPlace(req.params);
  deepSanitizeInPlace(req.query);
  stripDangerousObjectKeys(req.body);
  stripDangerousObjectKeys(req.params);
  stripDangerousObjectKeys(req.query);
  next();
});

// Logs and rate limiting
app.use(morgan("dev"));
app.use("/api", apiLimiter);

// Routes
app.use("/api/v1/health", (req, res) => {
  res.status(200).send("API is running");
});
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/chat", chatRoutes);
app.use("/api/v1/posts", postRoutes);
app.use("/api/v1/days", dayRoutes);
app.use("/api/v1/reports", reportRoutes);
app.use("/api/v1/system", systemRoutes);
app.use("/api/v1/admin", adminRoutes);

// Serve local uploads if present (fallback when Cloudinary isn't configured)
// Files saved under /uploads will be exposed at /uploads/*
const uploadsDir = path.join(process.cwd(), "uploads");
app.use("/uploads", express.static(uploadsDir, {
  maxAge: "7d",
  fallthrough: true,
}));

// Error handler (last)
app.use(errorHandler);

// Start Server after DB connects
const PORT = process.env.PORT || 5000;
async function start() {
  await connectDB();
  try {
    const cleanup = await User.updateMany(
      {
        location: { $exists: true },
        $or: [
          { "location.coordinates": { $exists: false } },
          { "location.coordinates.1": { $exists: false } },
        ],
      },
      { $unset: { location: "", locationUpdatedAt: "" } }
    );
    if ((cleanup?.modifiedCount || 0) > 0) {
      console.log(`[startup] cleared invalid locations: ${cleanup.modifiedCount}`);
    }
  } catch (e) {
    console.warn("[startup] location cleanup failed:", e?.message || e);
  }
  const server = http.createServer(app);
  initSocket(server);
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
