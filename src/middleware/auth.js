import jwt from "jsonwebtoken";
import User from "../models/user.model.js";

export default async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [, token] = header.split(" ");
    if (!token) return res.status(401).json({ message: "Missing Authorization token" });

    const jwtVerifyOptions = {
      algorithms: ["HS256"],
    };
    if (process.env.JWT_ISSUER) jwtVerifyOptions.issuer = process.env.JWT_ISSUER;
    if (process.env.JWT_AUDIENCE) jwtVerifyOptions.audience = process.env.JWT_AUDIENCE;

    const payload = jwt.verify(token, process.env.JWT_SECRET, jwtVerifyOptions);
    const user = await User.findById(payload.id).select("_id name nickname email verified avatarUrl");
    if (!user) return res.status(401).json({ message: "Invalid token" });

    // Best-effort presence + IP update (do not block request)
    const ipHeader = (req.headers['x-forwarded-for'] || '').toString();
    const forwardedIp = ipHeader.split(',')[0]?.trim();
    const ip = forwardedIp || req.headers['x-real-ip'] || req.ip || null;
    const update = { lastActiveAt: new Date() };
    if (ip) update.lastIp = ip;
    User.findByIdAndUpdate(user._id, update).catch(() => {});

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Unauthorized", error: err.message });
  }
}
