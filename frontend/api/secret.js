// /api/secret — stores and retrieves an ENCRYPTED duel secret blob.
// The server never sees the plaintext secret. It only stores/returns
// whatever ciphertext the client sends — it cannot decrypt it.
//
// Storage: Upstash Redis (REST API), via env vars auto-injected by Vercel:
//   KV_REST_API_URL
//   KV_REST_API_TOKEN
//
// Key scheme: "duelsecret:<walletAddress>:<duelId>"
//   - walletAddress is lowercased before use.
//   - Each key auto-expires after 7 days (plenty of time to reveal;
//     keeps the database from growing unbounded with stale data).

const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function buildKey(wallet, duelId) {
  return `duelsecret:${String(wallet).toLowerCase()}:${String(duelId)}`;
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
  // Basic CORS — adjust origin if you want to lock this down to your domain only.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    if (req.method === 'POST') {
      const { wallet, duelId, ciphertext } = req.body || {};

      if (!wallet || !duelId || !ciphertext) {
        res.status(400).json({ error: 'Missing wallet, duelId, or ciphertext' });
        return;
      }
      // Sanity cap — a chiphertext blob for a single secret should be tiny.
      if (typeof ciphertext !== 'string' || ciphertext.length > 10000) {
        res.status(400).json({ error: 'Invalid ciphertext' });
        return;
      }

      const key = buildKey(wallet, duelId);
      // SET key value EX seconds  →  Upstash REST: /set/<key>/<value>?EX=seconds
      await redisCall(
        `/set/${encodeURIComponent(key)}/${encodeURIComponent(ciphertext)}?EX=${TTL_SECONDS}`,
        { method: 'POST' }
      );

      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'GET') {
      const { wallet, duelId } = req.query || {};
      if (!wallet || !duelId) {
        res.status(400).json({ error: 'Missing wallet or duelId' });
        return;
      }

      const key = buildKey(wallet, duelId);
      const data = await redisCall(`/get/${encodeURIComponent(key)}`, { method: 'GET' });

      if (data.result == null) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.status(200).json({ ciphertext: data.result });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('secret.js error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}
