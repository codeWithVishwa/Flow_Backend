# Flowsnap Backend API

Express + Mongoose + Socket.IO service offering authentication, profile, real‑time chat (text + media), email verification and password reset.

## Features
- User registration, login, email verification, password reset
- Friend requests & contacts
- Real-time chat (text, image, video, audio) via Socket.IO
- Presence (online/offline broadcast)
- Profile editing: name, gender, interests, avatar (Cloudinary)
- Instagram-style posts with Cloudinary uploads (images + <=20s video) and likes
- Media thumbnails (images) with sharp
- Rate limiting, sanitization, helmet security headers

## Environment Variables
Copy `.env.example` to `.env` (local) or set in Render dashboard:
```
MONGO_URI=
JWT_SECRET=
JWT_ACCESS_TTL=15m                        # Optional (web access token TTL)
JWT_REFRESH_SECRET=                      # Optional but recommended (separate secret for refresh tokens)
JWT_REFRESH_DAYS=30                      # Optional (refresh lifetime in days)
JWT_REFRESH_COOKIE_SAMESITE=             # Optional: lax|strict|none (prod cross-site often needs 'none')
JWT_REFRESH_COOKIE_DOMAIN=               # Optional: e.g. .yourdomain.com
APP_BASE_URL=http://localhost:5000        # Set to https://<render-host>.onrender.com in production
FRONTEND_URL=flowsnap://                  # Deep link scheme
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
RESEND_API_KEY=                           # Obtain from https://resend.com (Project > API Keys)
EMAIL_FROM=App Name <no-reply@yourdomain.com>  # Verified sending domain/address in Resend
MAIL_DEBUG=false                          # Optional verbose logging
DEV_EMAIL_DISABLE=false                   # Skip sending entirely when true
DISABLE_RATE_LIMIT=true                  # Optional: disable API/auth rate limiting (dev default is disabled)
```

### Email Sending (Resend)
The backend now uses the Resend REST API instead of SMTP/Gmail. Benefits: no blocked ports, simple API key auth, reliable delivery.

Minimum required: `RESEND_API_KEY`, `EMAIL_FROM`.
Make sure the domain in `EMAIL_FROM` is verified in your Resend dashboard; otherwise messages may be rejected.

Example production config:
```
RESEND_API_KEY=re_XXXXXXXXXXXXXXXXXXXX
EMAIL_FROM=Flowsnap <no-reply@yourdomain.com>
MAIL_DEBUG=false
```

Disable all email (e.g., tests):
```
DEV_EMAIL_DISABLE=true
```

### Health Endpoint
`GET /api/v1/auth/smtp-health` (legacy path) now returns:
```
{
  "ok": true,
  "health": {
    "usingResend": true,
    "lastSendId": "<id or null>",
    "lastSendError": null,
    "debug": false
  }
}
```
If `lastSendError` persists, verify API key/domain and check Resend dashboard logs.

## Auth Endpoints (`/api/v1/auth`)
- `POST /register` { name, email, password }
- `POST /login` { email, password }
- `POST /send-verification` { email }
- `GET  /verify-email?token=...&email=...`
- `POST /verify-email-otp` { email, otp }
- `POST /forgot-password` { email }
- `POST /reset-password?token=...&email=...` { password }
- `POST /reset-password-otp` { email, otp, password }

### Web Auth Endpoints (`/api/v1/auth/web`)
These are designed for browser apps (React/Vite/Next.js) using an HttpOnly refresh cookie.

- `POST /login` { email, password } → sets refresh cookie; returns `{ accessToken, user }`
- `POST /refresh` → rotates refresh cookie; returns `{ accessToken }`
- `POST /logout` → clears refresh cookie; returns `{ ok: true }`

Client notes:
- Use `credentials: 'include'` (fetch) or `withCredentials: true` (axios) so cookies are sent.
- In production with different domains (e.g. `app.domain.com` → `api.domain.com`), you typically need HTTPS and `JWT_REFRESH_COOKIE_SAMESITE=none`.

## User Endpoints (`/api/v1/users`) [auth]
- `GET /search?q=term`
- `POST /request/:userId`
- `GET /requests`
- `POST /requests/:requestId/respond` { action: accept|decline }
- `GET /contacts`
- `GET /me`
- `PATCH /me` { name?, gender?, interests?: string[] }
- `POST /me/avatar` (form-data avatar)
- `GET /online`

## Chat Endpoints (`/api/v1/chat`) [auth]
- `GET /conversations`
- `POST /conversations/:userId`
- `GET /conversations/:conversationId/messages?before&limit`
- `POST /conversations/:conversationId/messages` { text }
- `POST /conversations/:conversationId/media` form-data: media (image|video|audio)
- `POST /conversations/:conversationId/read`

### Message Shape
```
{
  _id, conversation, sender,
  type: "text" | "image" | "video" | "audio",
  text?, mediaUrl?, thumbUrl?, mediaDuration?,
  createdAt, updatedAt
}
```

## Post Endpoints (`/api/v1/posts`) [auth]
- `POST /media` form-data: `media` (image or video up to 20s). Returns a Cloudinary descriptor used when composing posts.
- `POST /` { caption?: string, media?: Array<CloudinaryDescriptor> } — accepts up to 4 media items (max 1 video) and auto-sets visibility to `public` or `private` based on the author's profile.
- `GET /feed?before&limit` — paginated feed containing public posts, your posts, plus private posts from accepted friends.
- `GET /user/:userId?before&limit` — paginated posts for a specific profile, respecting privacy rules.
- `POST /:postId/like` — like a post you are allowed to view.
- `DELETE /:postId/like` — remove a like (same visibility rules as like).
- `GET /:postId/comments?before&limit` — fetch paginated comments for a post you can view.
- `POST /:postId/comments` { text } — add a comment to a post (auto-increments `commentCount`).
- `DELETE /:postId` — author-only removal of a post (removes Cloudinary links only from DB; media stays in Cloudinary until managed separately).

## Socket.IO Events
- Client joins room `user:<userId>` automatically.
- `message:new` { conversationId, message }
- `presence:update` { userId, online }

## Development
```powershell
cd Backend
npm install
npm run dev
```
Health: http://localhost:5000/api/v1/health

## Deployment (Render)
1. Create Web Service (root: Backend). Build: `npm install` Start: `npm run start`.
2. Set env vars (see list). First deploy yields URL.
3. Set `APP_BASE_URL` to the Render URL and redeploy to fix email links.
4. Point Expo app: `EXPO_PUBLIC_API_BASE_URL=https://<render-host>.onrender.com`.
5. Confirm email health: `curl https://<render-host>.onrender.com/api/v1/auth/smtp-health`.

## Media Notes
- Images: resized thumbnail (320x320 webp) plus full media upload.
- Audio & video uploaded via base64; consider direct upload for very large files.
- Improve playback later using `expo-av` components.
- Fallback when Cloudinary is not configured: files are stored locally under `/uploads` and served at `GET /uploads/*`. This is convenient for local dev but not recommended for production (ephemeral file systems).
- Limits: avatars up to 5 MB; chat media (image/video/audio) up to 50 MB. Posts accept up to 4 media assets per post and only one video (<=20 seconds, 50 MB upload cap). Comments max 500 chars. Adjust in `src/middleware/upload.js` and `posts.controller.js` if needed.

## Security & Hardening
- bcrypt for passwords
- helmet headers
- rate limiting (global & auth)
- HTML sanitization of request payloads

## Next Improvements
- Video thumbnail via Cloudinary transformation
- Audio/video inline players
- Typing indicators, message delivery status
- Pagination & infinite scroll
- Unit/integration tests (Jest + supertest)

## License
Proprietary / Internal (adjust as needed).

