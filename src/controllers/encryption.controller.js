import User from "../models/user.model.js";

const BASE64_REGEX = /^[A-Za-z0-9+/=]+$/;

export const uploadEncryptionPublicKey = async (req, res) => {
  try {
    const { publicKey } = req.body;
    if (!publicKey || typeof publicKey !== "string" || publicKey.length < 40 || !BASE64_REGEX.test(publicKey)) {
      return res.status(400).json({ message: "Invalid public key" });
    }
    await User.findByIdAndUpdate(req.user._id, { encryptionPublicKey: publicKey });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const getEncryptionPublicKey = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id).select("encryptionPublicKey");
    if (!user || !user.encryptionPublicKey) {
      return res.status(404).json({ message: "Public key not found" });
    }
    res.json({ publicKey: user.encryptionPublicKey });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};
