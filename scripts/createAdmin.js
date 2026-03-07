import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import connectDB from "../src/config/db.js";
import User from "../src/models/user.model.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

async function run() {
  const email = String(process.argv[2] || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.argv[3] || process.env.ADMIN_PASSWORD || "");
  const name = String(process.argv[4] || process.env.ADMIN_NAME || "Admin").trim();

  if (!email || !password) {
    console.error("Usage: node scripts/createAdmin.js <email> <password> [name]");
    console.error("Or set ADMIN_EMAIL and ADMIN_PASSWORD in Backend/.env");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  await connectDB();

  const existing = await User.findOne({ email }).select("_id role name");
  const hash = await bcrypt.hash(password, 12);

  if (existing) {
    existing.role = "admin";
    existing.name = name || existing.name;
    existing.password = hash;
    existing.status = "active";
    existing.verified = true;
    await existing.save();
    console.log(`Updated existing user as admin: ${email}`);
  } else {
    await User.create({
      name,
      email,
      password: hash,
      role: "admin",
      status: "active",
      verified: true,
      isVerified: true,
      verificationType: "official",
      verifiedAt: new Date(),
    });
    console.log(`Created admin user: ${email}`);
  }

  process.exit(0);
}

run().catch((e) => {
  console.error("Failed to create admin:", e?.message || e);
  process.exit(1);
});
