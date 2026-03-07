import User from '../models/user.model.js';

function sanitizeBase(name) {
  const cleaned = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (cleaned) return cleaned.slice(0, 18);
  return 'user';
}

function addCandidate(set, value) {
  if (!value) return;
  const trimmed = value.slice(0, 30);
  if (trimmed) set.add(trimmed);
}

export async function suggestUsernames(name, count = 5) {
  const base = sanitizeBase(name);
  const candidates = new Set();
  const nowSuffix = Date.now().toString().slice(-4);

  addCandidate(candidates, base);
  addCandidate(candidates, `${base}${Math.floor(Math.random() * 90 + 10)}`);
  addCandidate(candidates, `${base}${nowSuffix}`);
  addCandidate(candidates, `${base}_${Math.floor(Math.random() * 900 + 100)}`);
  addCandidate(candidates, `${base}.${Math.floor(Math.random() * 9000 + 1000)}`);

  while (candidates.size < 20) {
    const suffix = Math.floor(Math.random() * 9000 + 1000);
    const pattern = candidates.size % 2 === 0 ? `${base}${suffix}` : `${base}_${suffix}`;
    addCandidate(candidates, pattern);
  }

  const lowers = Array.from(candidates).map((c) => c.toLowerCase());
  const existing = await User.find({ nameLower: { $in: lowers } }).select('nameLower').lean();
  const taken = new Set((existing || []).map((u) => u.nameLower));
  const available = Array.from(candidates).filter((c) => !taken.has(c.toLowerCase()));
  return available.slice(0, count);
}
