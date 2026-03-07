import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import connectDB from "../src/config/db.js";
import User from "../src/models/user.model.js";

dotenv.config();

const SEED_USERS = [
  { username: "anime_core", email: "anime@appdemo.com", password: "Anime@123", category: "anime" },
  { username: "gym_alpha", email: "gym@appdemo.com", password: "Gym@123", category: "gym" },
  { username: "daily_motivation", email: "motivation@appdemo.com", password: "Motivate@123", category: "motivation" },
  { username: "funny_zone", email: "funny@appdemo.com", password: "Funny@123", category: "funny" },
  { username: "science_capsule", email: "science@appdemo.com", password: "Science@123", category: "science_facts" },
  { username: "tech_pulse", email: "tech@appdemo.com", password: "Tech@123", category: "technology" },
  { username: "code_stack", email: "coding@appdemo.com", password: "Code@123", category: "programming" },
  { username: "space_labs", email: "space@appdemo.com", password: "Space@123", category: "space" },
  { username: "mindset_daily", email: "mindset@appdemo.com", password: "Mind@123", category: "mindset" },
  { username: "travel_sphere", email: "travel@appdemo.com", password: "Travel@123", category: "travel" },
  { username: "food_labs", email: "food@appdemo.com", password: "Food@123", category: "food" },
  { username: "sports_arena", email: "sports@appdemo.com", password: "Sports@123", category: "sports" },
  { username: "gaming_zone", email: "gaming@appdemo.com", password: "Game@123", category: "gaming" },
  { username: "creative_hub", email: "art@appdemo.com", password: "Art@123", category: "creative" },
  { username: "business_stack", email: "business@appdemo.com", password: "Biz@123", category: "business" },
  { username: "quote_world", email: "quotes@appdemo.com", password: "Quote@123", category: "quotes" },
  { username: "ai_future", email: "ai@appdemo.com", password: "AI@123", category: "ai" },
  { username: "relationship_lab", email: "social@appdemo.com", password: "Social@123", category: "relationships" },
  { username: "startup_flow", email: "startup@appdemo.com", password: "Startup@123", category: "startups" },
];

async function upsertUser(entry) {
  const { username, email, password, category } = entry;
  const name = String(username || "").trim();
  const safeEmail = String(email || "").trim().toLowerCase();
  if (!name || !safeEmail || !password) return { email: safeEmail, status: "skipped" };

  const passwordHash = await bcrypt.hash(password, 10);
  const interests = [String(category || "").trim()].filter(Boolean);

  const existing = await User.findOne({ email: safeEmail });
  if (existing) {
    existing.name = name;
    existing.nickname = name;
    existing.password = passwordHash;
    existing.interests = interests;
    existing.verified = true;
    existing.isVerified = true;
    existing.verificationType = "official";
    existing.status = "active";
    await existing.save();
    return { email: safeEmail, status: "updated" };
  }

  const user = new User({
    name,
    nickname: name,
    email: safeEmail,
    password: passwordHash,
    interests,
    verified: true,
    isVerified: true,
    verificationType: "official",
    status: "active",
  });

  await user.save();
  return { email: safeEmail, status: "created" };
}

async function run() {
  await connectDB();
  const results = [];
  for (const entry of SEED_USERS) {
    // eslint-disable-next-line no-await-in-loop
    const result = await upsertUser(entry);
    results.push(result);
  }
  console.log("Seed complete:", results);
  process.exit(0);
}

run().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
