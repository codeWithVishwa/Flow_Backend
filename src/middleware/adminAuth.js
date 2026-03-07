import jwt from "jsonwebtoken";
import User from "../models/user.model.js";

export default async function adminAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [, token] = header.split(" ");
    if (!token) return res.status(401).json({ error: "Missing Authorization token" });

    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    const user = await User.findById(payload.id).select("_id name email role status");
    if (!user) return res.status(401).json({ error: "Invalid token" });
    if (user.status !== "active") return res.status(403).json({ error: "Account is not active" });
    if (user.role !== "admin") return res.status(403).json({ error: "Admin access required" });

    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Unauthorized", message: e.message });
  }
}
