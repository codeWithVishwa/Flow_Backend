import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
  gender: { type: String },
  phone: { type: String, default: null, trim: true },
  avatarUrl: { type: String, default: null },
  isPrivate: { type: Boolean, default: false },
  followers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  following: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  followRequests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  messageRequests: [
    {
      from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  allowGroupAdds: { type: Boolean, default: true },
  allowLocationDiscovery: { type: Boolean, default: false },
  savedPosts: [
    {
      post: { type: mongoose.Schema.Types.ObjectId, ref: 'Post', required: true },
      savedAt: { type: Date, default: Date.now },
    },
  ],
  location: {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], default: undefined },
  },
  locationUpdatedAt: { type: Date, default: null },
  encryptionPublicKey: { type: String, default: null },
  nickname: { type: String, trim: true, maxlength: 40, default: null },
  bio: { type: String, trim: true, maxlength: 300 },
    interests: [String],
    honorScore: { type: Number, default: 50 },
    verified: { type: Boolean, default: false },
    // Platform verification (admin-only)
    isVerified: { type: Boolean, default: false },
    verificationType: { type: String, enum: ['official', 'creator', 'developer'], default: null },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    verifiedAt: { type: Date, default: null },
    // Email verification
    emailVerificationToken: { type: String, default: null }, // stored as sha256 hash
    emailVerificationExpires: { type: Date, default: null },
    // Email verification via OTP (numeric code hashed)
    emailVerificationOTP: { type: String, default: null }, // sha256 hash of 6-digit code
    emailVerificationOTPExpires: { type: Date, default: null },
    // Password reset
    passwordResetToken: { type: String, default: null }, // stored as sha256 hash
    passwordResetExpires: { type: Date, default: null },
    // Password reset via OTP
    passwordResetOTP: { type: String, default: null }, // sha256 hash of 6-digit code
    passwordResetOTPExpires: { type: Date, default: null },
    // Vault PIN reset via OTP
    vaultPinResetOTP: { type: String, default: null },
    vaultPinResetOTPExpires: { type: Date, default: null },

    // Web auth: refresh token sessions (tokens stored as sha256 hashes)
    refreshTokens: [
      {
        tokenHash: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
        lastUsedAt: { type: Date, default: Date.now },
        expiresAt: { type: Date, required: true },
        userAgent: { type: String, default: null },
        deviceId: { type: String, default: null },
        deviceName: { type: String, default: null },
        ip: { type: String, default: null },
      },
    ],
    // Lowercase name for uniqueness enforcement (case-insensitive)
    nameLower: { type: String, index: true, unique: true, sparse: true },
    // Presence tracking
    lastActiveAt: { type: Date, default: Date.now, index: true },
    // Login tracking
    lastIp: { type: String, default: null },
    lastLoginAt: { type: Date, default: null },
    // Push Notifications
    pushToken: { type: String, default: null },
    pushTokenUpdatedAt: { type: Date, default: null },
    offlineNotifications: [{
      senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      count: { type: Number, default: 1 },
      lastMessage: { type: String },
      updatedAt: { type: Date, default: Date.now }
    }],
    // Users who have liked this profile
    profileLikes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    blockedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    status:{
      type: String, enum: ["active", "banned", "suspended", "deactivated"], default: 'active'
    },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    deactivatedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    isDeleted: { type: Boolean, default: false }
  },
  { timestamps: true }
);

userSchema.index({ followers: 1 });
userSchema.index({ following: 1 });
userSchema.index({ followRequests: 1 });
userSchema.index({ 'messageRequests.from': 1 });
userSchema.index({ 'savedPosts.post': 1 });
userSchema.index({ location: "2dsphere" });

userSchema.pre('save', function(next) {
  if (this.isModified('name') && typeof this.name === 'string') {
    this.nameLower = this.name.toLowerCase();
  }
  next();
});

userSchema.pre('save', function(next) {
  if (this.location && Array.isArray(this.location.coordinates)) {
    if (this.location.coordinates.length !== 2) {
      this.location = undefined;
      this.locationUpdatedAt = null;
    }
  } else if (this.location) {
    this.location = undefined;
    this.locationUpdatedAt = null;
  }
  next();
});

export default mongoose.model("User", userSchema);
