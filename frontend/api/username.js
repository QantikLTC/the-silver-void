// /api/username — get/set a player's display name.
//
// Storage (Upstash Redis REST API via Vercel KV):
//   username:<wallet>           -> the player's chosen name (lowercased wallet key)
//   usernametaken:<name_lower>  -> the wallet that owns this name (for uniqueness, case-insensitive)
//
// Rules enforced server-side:
//   - 3 to 16 characters
//   - letters, numbers, underscore, hyphen only
//   - case-insensitive uniqueness
//   - basic banned-word filter
//
// This does NOT enforce the "must have Simple Holder rank" or "first is free,
// then pay to change" business rules — those are enforced by the FRONTEND
// before calling this API (the frontend checks the rank and, for paid changes,
// requires a successful on-chain payment tx before calling this endpoint).
// The server only guarantees format validity + uniqueness.

const MIN_LEN = 3;
const MAX_LEN = 16;
const NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

// Minimal banned-word filter — extend this list as needed.
const BANNED_WORDS = [
  'admin', 'moderator', 'fuck', 'shit', 'cunt', 'nigger', 'rape',
  'hitler', 'nazi', 'support', 'official'
];

function isBanned(name) {
  const lower = name.toLowerCase();
  return BANNED_WORDS.some(w => lower.includes(w));
}

async function redisCall(path, opts = {}) {
  const url = `${process.env.KV_REST_API_URL}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Redis call failed (${res.status}): ${text}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === 'GET') {
      const { wallet } = req.query || {};
      if (!wallet) {
        res.status(400).json({ error: 'Missing wallet' });
        return;
      }
      const key = `username:${wallet.toLowerCase()}`;
      const data = await redisCall(`/get/${encodeURIComponent(key)}`, { method: 'GET' });
      res.status(200).json({ username: data.result || null });
      return;
    }

    if (req.method === 'POST') {
      const { wallet, username } = req.body || {};
      if (!wallet || !username) {
        res.status(400).json({ error: 'Missing wallet or username' });
        return;
      }

      const trimmed = String(username).trim();

      // ── Format validation ──
      if (trimmed.length < MIN_LEN || trimmed.length > MAX_LEN) {
        res.status(400).json({ error: `Username must be ${MIN_LEN}-${MAX_LEN} characters.` });
        return;
      }
      if (!NAME_REGEX.test(trimmed)) {
        res.status(400).json({ error: 'Only letters, numbers, _ and - are allowed.' });
        return;
      }
      if (isBanned(trimmed)) {
        res.status(400).json({ error: 'This name is not allowed.' });
        return;
      }

      const walletKey = wallet.toLowerCase();
      const nameLower = trimmed.toLowerCase();
      const takenKey = `usernametaken:${nameLower}`;

      // ── Uniqueness check (case-insensitive) ──
      const existing = await redisCall(`/get/${encodeURIComponent(takenKey)}`, { method: 'GET' });
      if (existing.result && existing.result !== walletKey) {
        res.status(409).json({ error: 'This name is already taken.' });
        return;
      }

      // ── Release the player's previous name reservation, if any ──
      const userKey = `username:${walletKey}`;
      const prev = await redisCall(`/get/${encodeURIComponent(userKey)}`, { method: 'GET' });
      if (prev.result) {
        const prevTakenKey = `usernametaken:${prev.result.toLowerCase()}`;
        if (prevTakenKey !== takenKey) {
          await redisCall(`/del/${encodeURIComponent(prevTakenKey)}`, { method: 'POST' });
        }
      }

      // ── Reserve the new name and save it ──
      await redisCall(`/set/${encodeURIComponent(takenKey)}/${encodeURIComponent(walletKey)}`, { method: 'POST' });
      await redisCall(`/set/${encodeURIComponent(userKey)}/${encodeURIComponent(trimmed)}`, { method: 'POST' });

      res.status(200).json({ ok: true, username: trimmed });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('username.js error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}
