// /api/avatar — get/set a player's chosen avatar.
//
// The avatar itself is just an ID string (e.g. "rank_2", "feat_first_win") —
// the frontend maps IDs to actual icons/emoji. This endpoint does NOT verify
// that the player has actually unlocked the chosen avatar; the frontend is
// responsible for only offering unlocked options in the picker UI.
//
// Storage (Upstash Redis REST API via Vercel KV):
//   avatar:<wallet> -> avatar id string
//
// ═══ CORRECTIFS (audit coûts & robustesse) ═══
//
// 1. GET mis en cache au CDN (30 s, périmé servi 5 min pendant le rafraîchi).
//    Avant : AUCUN en-tête de cache, donc chaque appel réveillait la fonction
//    ET coûtait une commande Redis. Courte durée pour qu'un changement
//    d'avatar reste visible rapidement (le batch /api/profiles?fresh=1 sert
//    déjà la version fraîche au joueur concerné).
//
// 2. Si Redis est indisponible (quota, panne), le GET répond 200 avec
//    avatar:null au lieu d'un 500. Le site affiche l'avatar par défaut au
//    lieu de casser, et le navigateur n'a aucune raison de relancer en boucle.
//
// 3. ÉCRITURE PROTÉGÉE PAR LA SESSION. Le POST exige la session de connexion
//    du joueur (cookie posé par /api/auth après UNE signature). Avant,
//    n'importe qui pouvait changer l'avatar de n'importe quel joueur.

import { sessionAddress } from './_session.js';

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
      const key = `avatar:${String(wallet).toLowerCase()}`;
      try {
        const data = await redisCall(`/get/${encodeURIComponent(key)}`, { method: 'GET' });
        res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=300');
        res.status(200).json({ avatar: data.result || null });
      } catch (e) {
        console.error('avatar.js GET degraded:', e.message);
        res.setHeader('Cache-Control', 'public, s-maxage=10');
        res.status(200).json({ avatar: null, degraded: true });
      }
      return;
    }

    if (req.method === 'POST') {
      const { wallet, avatar } = req.body || {};
      if (!wallet || !avatar) {
        res.status(400).json({ error: 'Missing wallet or avatar' });
        return;
      }
      const me = sessionAddress(req);
      if (!me || me !== String(wallet).toLowerCase()) {
        res.status(401).json({ error: 'Sign in required' });
        return;
      }
      if (avatar.length > MAX_ID_LEN || !ID_REGEX.test(avatar)) {
        res.status(400).json({ error: 'Invalid avatar id' });
        return;
      }

      const key = `avatar:${String(wallet).toLowerCase()}`;
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
