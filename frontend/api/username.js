// /api/username — get/set a player's display name.
//
// Storage (Upstash Redis REST API via Vercel KV):
//   username:<wallet>           -> the player's chosen name (lowercased wallet key)
//   usernametaken:<name_lower>  -> the wallet that owns this name (case-insensitive)
//
// ═══ WHAT CHANGED AND WHY ═══
//
// 1. SIGNED WRITES. The old POST took { wallet, username } and trusted both.
//    Anyone could rename any player — including overwriting a name they didn't
//    own — with a single curl. Writes now require a signature produced by the
//    wallet's private key over a fixed message; the server recovers the signer
//    and only accepts the write if it matches the wallet being changed.
//
// 2. CORS RESTRICTED. Was '*', so any site on the internet could call this
//    endpoint from a visitor's browser. Now limited to the project's own
//    origins.
//
// 3. CACHED READS. GET responses are cacheable at the edge for 5 minutes.
//    Names change rarely, and a burst of scripted traffic on this route (25k
//    invocations in an hour, from scattered ASNs) is what prompted this pass —
//    cached reads are served without invoking the function at all.
//
// 4. LIGHT RATE LIMIT on writes, per wallet, so a leaked signature can't be
//    replayed into a rename loop.
//
// Business rules (rank required, first change free) still live in the frontend;
// this endpoint guarantees format, uniqueness, and now ownership.

import { verifyMessage } from 'ethers';

const MIN_LEN = 3;
const MAX_LEN = 16;
const NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

// Must match exactly what the frontend asks the wallet to sign.
const SIGN_MESSAGE = 'The Silver Void — set my display name';

// Origins allowed to call this endpoint from a browser.
const ALLOWED_ORIGINS = [
  'https://thesilvervoid.com',
  'https://www.thesilvervoid.com',
];

const BANNED_WORDS = [
  'admin', 'moderator', 'fuck', 'shit', 'cunt', 'nigger', 'rape',
  'hitler', 'nazi', 'support', 'official',
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

/// Allows same-origin requests (no Origin header) and the project's own sites.
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;                       // same-origin / server-side
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    return true;
  }
  return false;
}

/// One rename per wallet per 30s. Enough to stop a loop, invisible to a human.
async function rateLimited(walletKey) {
  const key = `ratelimit:username:${walletKey}`;
  try {
    const hit = await redisCall(`/get/${encodeURIComponent(key)}`, { method: 'GET' });
    if (hit.result) return true;
    await redisCall(`/set/${encodeURIComponent(key)}/1?EX=30`, { method: 'POST' });
    return false;
  } catch (e) {
    // A failing limiter must not block legitimate writes.
    console.warn('rate limit check failed:', e.message);
    return false;
  }
}

export default async function handler(req, res) {
  const corsOk = applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(corsOk ? 204 : 403).end();
    return;
  }
  if (!corsOk) {
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }

  try {
    // ───────────────────────── GET ─────────────────────────
    if (req.method === 'GET') {
      const { wallet } = req.query || {};
      if (!wallet) {
        res.status(400).json({ error: 'Missing wallet' });
        return;
      }
      const key = `username:${String(wallet).toLowerCase()}`;
      const data = await redisCall(`/get/${encodeURIComponent(key)}`, { method: 'GET' });

      // Served from the edge for 5 minutes; stale copies may be reused for an
      // hour while a fresh one is fetched in the background.
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
      res.status(200).json({ username: data.result || null });
      return;
    }

    // ───────────────────────── POST ─────────────────────────
    if (req.method === 'POST') {
      const { wallet, username, signature } = req.body || {};
      if (!wallet || !username || !signature) {
        res.status(400).json({ error: 'Missing wallet, username, or signature' });
        return;
      }

      // ── Ownership: recover the signer and require it to be the wallet ──
      let signer;
      try {
        signer = verifyMessage(SIGN_MESSAGE, signature);
      } catch (e) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
      if (signer.toLowerCase() !== String(wallet).toLowerCase()) {
        res.status(401).json({ error: 'Signature does not match wallet' });
        return;
      }

      const walletKey = String(wallet).toLowerCase();
      if (await rateLimited(walletKey)) {
        res.status(429).json({ error: 'Too many changes — wait a moment.' });
        return;
      }

      const trimmed = String(username).trim();

      // ── Format ──
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

      const nameLower = trimmed.toLowerCase();
      const takenKey = `usernametaken:${nameLower}`;

      // ── Uniqueness (case-insensitive) ──
      const existing = await redisCall(`/get/${encodeURIComponent(takenKey)}`, { method: 'GET' });
      if (existing.result && existing.result !== walletKey) {
        res.status(409).json({ error: 'This name is already taken.' });
        return;
      }

      // ── Release the previous reservation, if any ──
      const userKey = `username:${walletKey}`;
      const prev = await redisCall(`/get/${encodeURIComponent(userKey)}`, { method: 'GET' });
      if (prev.result) {
        const prevTakenKey = `usernametaken:${prev.result.toLowerCase()}`;
        if (prevTakenKey !== takenKey) {
          await redisCall(`/del/${encodeURIComponent(prevTakenKey)}`, { method: 'POST' });
        }
      }

      // ── Reserve and save ──
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
