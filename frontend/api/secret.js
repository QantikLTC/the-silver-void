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
//   - Each key auto-expires after 7 days.
//
// ═══ CORRECTIF (audit sécurité) ═══
//
// ÉCRITURE UNIQUE. Avant, n'importe qui pouvait ÉCRASER la sauvegarde d'un
// autre joueur : l'adresse et le numéro de duel sont publics sur la chaîne.
// Si ce joueur avait perdu son localStorage, sa sauvegarde était remplacée
// par des données qu'il ne peut pas déchiffrer, et il ne pouvait plus révéler.
//
// Le site n'écrit la sauvegarde qu'UNE fois, à la création du duel. On
// l'impose donc côté serveur : SET ... NX, la première écriture gagne, les
// suivantes sont refusées (409). Aucun changement nécessaire côté site.
//
// Limite restante : un tricheur très rapide pourrait écrire AVANT le joueur,
// juste après la création du duel. Le localStorage reste la source
// principale, donc l'impact est faible ; la protection complète serait une
// signature du wallet avec un message DIFFÉRENT de SECRET_SIGN_MESSAGE
// (cette signature-là sert de clé de chiffrement et ne doit jamais être
// envoyée au serveur).

const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function buildKey(wallet, duelId) {
  return `duelsecret:${String(wallet).toLowerCase()}:${String(duelId)}`;
}

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

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
      if (typeof ciphertext !== 'string' || ciphertext.length > 10000) {
        res.status(400).json({ error: 'Invalid ciphertext' });
        return;
      }
      if (String(duelId).length > 120 || !/^0x[a-fA-F0-9]{40}$/.test(String(wallet))) {
        res.status(400).json({ error: 'Invalid wallet or duelId' });
        return;
      }

      const key = buildKey(wallet, duelId);
      const ok = await redisCmd(['SET', key, ciphertext, 'NX', 'EX', String(TTL_SECONDS)]);
      if (ok !== 'OK') {
        // Déjà sauvegardé : on ne remplace jamais une sauvegarde existante.
        res.status(409).json({ error: 'Backup already exists' });
        return;
      }

      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'GET') {
      const { wallet, duelId } = req.query || {};
      if (!wallet || !duelId) {
        res.status(400).json({ error: 'Missing wallet or duelId' });
        return;
      }

      const data = await redisCmd(['GET', buildKey(wallet, duelId)]);
      if (data == null) {
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.status(200).json({ ciphertext: data });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('secret.js error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}
