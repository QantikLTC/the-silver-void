// /api/avatar — get/set a player's chosen avatar.
//
// The avatar itself is just an ID string (e.g. "rank_2", "feat_first_win") —
// the frontend maps IDs to actual icons/emoji. This endpoint does NOT verify
// that the player has actually unlocked the chosen avatar; the frontend is
// responsible for only offering unlocked options in the picker UI. This
// mirrors how feats/ranks are already tracked client-side from on-chain data
// plus localStorage, so re-verifying server-side would require duplicating
// that logic here for a purely cosmetic feature — not worth the complexity
// at this stage.
//
// Storage (Upstash Redis REST API via Vercel KV):
//   avatar:<wallet> -> avatar id string

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

const MAX_ID_LEN = 40;
const ID_REGEX = /^[a-zA-Z0-9_]+$/;

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
      const key = `avatar:${wallet.toLowerCase()}`;
      const data = await redisCall(`/get/${encodeURIComponent(key)}`, { method: 'GET' });
      res.status(200).json({ avatar: data.result || null });
      return;
    }

    if (req.method === 'POST') {
      const { wallet, avatar } = req.body || {};
      if (!wallet || !avatar) {
        res.status(400).json({ error: 'Missing wallet or avatar' });
        return;
      }
      if (avatar.length > MAX_ID_LEN || !ID_REGEX.test(avatar)) {
        res.status(400).json({ error: 'Invalid avatar id' });
        return;
      }

      const key = `avatar:${wallet.toLowerCase()}`;
      await redisCall(`/set/${encodeURIComponent(key)}/${encodeURIComponent(avatar)}`, { method: 'POST' });

      res.status(200).json({ ok: true, avatar });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('avatar.js error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}
