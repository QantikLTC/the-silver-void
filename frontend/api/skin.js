// /api/skin — get/set a player's equipped cosmetic skin + owned list.
//
// A skin is just an ID string (e.g. "ring_ember", "title_voidwalker",
// "aura_satellite") — the frontend maps IDs to CSS effects. Follows the
// same pattern as /api/avatar and /api/username.
//
// Storage (Upstash Redis REST API via Vercel KV):
//   skin:<wallet>       -> currently equipped skin id (read by everyone,
//                          e.g. to render rings in the Duelist leaderboard)
//   skinsowned:<wallet> -> JSON array of owned skin ids
//   skintx:<wallet>:<skinId> -> payment tx hash, stored for audit
//
// Business rules & trust model:
//   - FREE skins (rarity "common"/feat-unlocked) can be equipped directly.
//   - PAID skins: the frontend requires a successful on-chain payment/burn
//     tx BEFORE calling POST {buy}. Like the paid username change, the
//     server currently trusts the frontend but records the tx hash — so
//     any abuse is auditable, and server-side on-chain verification of the
//     tx (amount + recipient) can be added later without changing the API.
//   - Equipping requires the skin to be in the owned list (or free).
//
// FREE_SKINS below must match the frontend's Forge catalog.

const MAX_ID_LEN = 40;
const ID_REGEX = /^[a-zA-Z0-9_]+$/;
const TX_REGEX = /^0x[a-fA-F0-9]{64}$/;

// Skins equipables sans achat (défaut + communs offerts au lancement).
// Les skins débloqués par hauts faits passent par POST {buy} avec
// tx:"feat" — même logique "le frontend a vérifié" que pour l'avatar.
const FREE_SKINS = ['ring_default'];

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

async function getOwned(walletKey) {
  const data = await redisCall(`/get/${encodeURIComponent('skinsowned:' + walletKey)}`, { method: 'GET' });
  if (!data.result) return [];
  try {
    const arr = JSON.parse(data.result);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
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
      // Stat globale : total de skins forgés (aucun wallet requis).
      if (req.query && req.query.stats === '1') {
        const data = await redisCall(`/get/${encodeURIComponent('skins:sold:total')}`, { method: 'GET' });
        res.status(200).json({ totalForged: Number(data.result) || 0 });
        return;
      }

      const { wallet } = req.query || {};
      if (!wallet) {
        res.status(400).json({ error: 'Missing wallet' });
        return;
      }
      const walletKey = wallet.toLowerCase();
      const data = await redisCall(`/get/${encodeURIComponent('skin:' + walletKey)}`, { method: 'GET' });
      const owned = await getOwned(walletKey);
      res.status(200).json({ skin: data.result || null, owned });
      return;
    }

    if (req.method === 'POST') {
      const { wallet, skin, buy, tx } = req.body || {};
      if (!wallet) {
        res.status(400).json({ error: 'Missing wallet' });
        return;
      }
      const walletKey = wallet.toLowerCase();

      // ── BUY: record a purchase (or a feat unlock) ──
      if (buy) {
        if (buy.length > MAX_ID_LEN || !ID_REGEX.test(buy)) {
          res.status(400).json({ error: 'Invalid skin id' });
          return;
        }
        // A payment tx hash (or the literal "feat" for feat-unlocked skins)
        // is required — same trust model as the paid username change: the
        // frontend only calls this after the on-chain tx succeeded.
        if (!tx || (tx !== 'feat' && !TX_REGEX.test(tx))) {
          res.status(400).json({ error: 'Missing or invalid payment tx' });
          return;
        }
        const owned = await getOwned(walletKey);
        if (!owned.includes(buy)) {
          owned.push(buy);
          await redisCall(
            `/set/${encodeURIComponent('skinsowned:' + walletKey)}/${encodeURIComponent(JSON.stringify(owned.slice(0, 100)))}`,
            { method: 'POST' }
          );
          await redisCall(
            `/set/${encodeURIComponent('skintx:' + walletKey + ':' + buy)}/${encodeURIComponent(tx)}`,
            { method: 'POST' }
          );
          // Compteur global de skins forgés (achats pay\u00e9s uniquement,
          // pas les d\u00e9blocages par haut fait qui utilisent tx:"feat").
          if (tx !== 'feat') {
            await redisCall(`/incr/${encodeURIComponent('skins:sold:total')}`, { method: 'POST' });
          }
        }
        res.status(200).json({ ok: true, owned });
        return;
      }

      // ── EQUIP: set the currently displayed skin ──
      if (!skin) {
        res.status(400).json({ error: 'Missing skin' });
        return;
      }
      if (skin.length > MAX_ID_LEN || !ID_REGEX.test(skin)) {
        res.status(400).json({ error: 'Invalid skin id' });
        return;
      }
      if (!FREE_SKINS.includes(skin)) {
        const owned = await getOwned(walletKey);
        if (!owned.includes(skin)) {
          res.status(403).json({ error: 'Skin not owned' });
          return;
        }
      }
      await redisCall(
        `/set/${encodeURIComponent('skin:' + walletKey)}/${encodeURIComponent(skin)}`,
        { method: 'POST' }
      );
      res.status(200).json({ ok: true, skin });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('skin.js error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}
