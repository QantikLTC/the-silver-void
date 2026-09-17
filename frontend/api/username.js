// /api/username — get/set a player's display name.
//
// Storage (Upstash Redis REST API via Vercel KV):
//   username:<wallet>           -> the player's chosen name (lowercased wallet key)
//   usernametaken:<name_lower>  -> the wallet that owns this name (case-insensitive)
//
// ═══ WHAT CHANGED AND WHY ═══
//
// 1. SIGNED WRITES. Writes require a signature produced by the wallet's private
//    key over a fixed message; the server recovers the signer and only accepts
//    the write if it matches the wallet being changed.
// 2. CORS RESTRICTED to the project's own origins.
// 3. CACHED READS at the edge for 5 minutes.
// 4. LIGHT RATE LIMIT on writes, per wallet.
//
// ═══ CORRECTIFS (audit coûts & robustesse) ═══
//
// 5. GET dégradé : si Redis est indisponible, 200 avec username:null au lieu
//    d'un 500. C'est cette route qui a produit ~3000 erreurs le 17 septembre
//    pendant l'épuisement du quota Upstash.
// 6. Limiteur en UNE commande (SET NX EX) au lieu de deux (GET puis SET).
//    Plus économique, et sans la course où deux requêtes simultanées
//    passaient toutes les deux le GET avant le SET.
//
// Business rules (rank required, first change free) still live in the frontend.

import { verifyMessage } from 'ethers';

const MIN_LEN = 3;
const MAX_LEN = 16;
const NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

// Must match exactly what the frontend asks the wallet to sign.
const SIGN_MESSAGE = 'The Silver Void — set my display name';

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

/// Commande Redis au format tableau (même forme que dans leaderboard.js).
async function redisCmd(cmd) {
  const res = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmd),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.error)) {
    throw new Error(`Redis ${cmd[0]}: HTTP ${res.status} ${json && json.error ? json.error : ''}`);
  }
  return json ? json.result : null;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    return true;
  }
  return false;
}

/// One rename per wallet per 30s, in a single atomic command.
/// SET NX renvoie "OK" si la clé n'existait pas (on laisse passer),
/// null si elle existe déjà (on bloque).
async function rateLimited(walletKey) {
  try {
    const ok = await redisCmd(['SET', `ratelimit:username:${walletKey}`, '1', 'NX', 'EX', '30']);
    return ok !== 'OK';
  } catch (e) {
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
      try {
        const data = await redisCall(`/get/${encodeURIComponent(key)}`, { method: 'GET' });
        res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
        res.status(200).json({ username: data.result || null });
      } catch (e) {
        console.error('username.js GET degraded:', e.message);
        res.setHeader('Cache-Control', 'public, s-maxage=10');
        res.status(200).json({ username: null, degraded: true });
      }
      return;
    }

    // ───────────────────────── POST ─────────────────────────
    if (req.method === 'POST') {
      const { wallet, username, signature } = req.body || {};
      if (!wallet || !username || !signature) {
        res.status(400).json({ error: 'Missing wallet, username, or signature' });
        return;
      }

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

      const existing = await redisCall(`/get/${encodeURIComponent(takenKey)}`, { method: 'GET' });
      if (existing.result && existing.result !== walletKey) {
        res.status(409).json({ error: 'This name is already taken.' });
        return;
      }

      const userKey = `username:${walletKey}`;
      const prev = await redisCall(`/get/${encodeURIComponent(userKey)}`, { method: 'GET' });
      if (prev.result) {
        const prevTakenKey = `usernametaken:${prev.result.toLowerCase()}`;
        if (prevTakenKey !== takenKey) {
          await redisCall(`/del/${encodeURIComponent(prevTakenKey)}`, { method: 'POST' });
        }
      }

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
