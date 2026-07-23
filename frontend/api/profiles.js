// /api/profiles — batch read of username + avatar + skin for many wallets.
//
// WHY THIS EXISTS (Vercel Fluid CPU quota):
// The leaderboard scans used to call /api/username, /api/avatar and
// /api/skin once PER WALLET — 3 function invocations × ~20 wallets ×
// every scan × every open tab. This endpoint replaces all of that with
// ONE invocation and ONE Redis MGET, and its responses are cached at
// Vercel's CDN edge so repeated identical requests (same sorted wallet
// list, any visitor) don't invoke the function at all.
//
// GET /api/profiles?wallets=0xaaa,0xbbb,...   (max 60, lowercase)
// -> { profiles: { "0xaaa": { username, avatar, skin }, ... } }
//
// Storage read (Upstash Redis REST API via Vercel KV):
//   username:<wallet>, avatar:<wallet>, skin:<wallet>

const MAX_WALLETS = 60;
const WALLET_REGEX = /^0x[a-f0-9]{40}$/;

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
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const raw = (req.query.wallets || '').toString();
    const wallets = [...new Set(raw.split(',').map(w => w.trim().toLowerCase()).filter(Boolean))]
      .filter(w => WALLET_REGEX.test(w))
      .slice(0, MAX_WALLETS)
      .sort();

    if (!wallets.length) {
      res.status(400).json({ error: 'Missing or invalid wallets' });
      return;
    }

    // One MGET for the whole board: [u1, a1, s1, u2, a2, s2, ...]
    const keys = [];
    for (const w of wallets) keys.push(`username:${w}`, `avatar:${w}`, `skin:${w}`);

    const data = await redisCall('/mget/' + keys.map(encodeURIComponent).join('/'), { method: 'GET' });
    const vals = Array.isArray(data.result) ? data.result : [];

    const profiles = {};
    wallets.forEach((w, i) => {
      profiles[w] = {
        username: vals[i * 3] || null,
        avatar: vals[i * 3 + 1] || null,
        skin: vals[i * 3 + 2] || null,
      };
    });

    // A player can ask for a single wallet (their own) to bypass the shared
    // board cache — that request is never cached, so a freshly changed
    // avatar or username shows up immediately instead of waiting for the
    // edge entry to expire. Board-sized requests keep their cache.
    if (req.query.fresh === '1' || wallets.length === 1) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      // CDN edge cache. Kept short: cosmetic changes (avatar, username,
      // ring skin) must become visible quickly, otherwise a player who
      // just changed their portrait keeps seeing the old one served from
      // the edge, with no way to force a refresh. 15s still absorbs the
      // bulk of repeated scans (every open tab, every 30s refresh cycle)
      // which is what the quota protection actually needs.
      res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=60');
    }

    res.status(200).json({ profiles });
  } catch (e) {
    console.error('profiles.js error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}
