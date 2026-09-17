// /api/skin — get/set a player's equipped cosmetic skin + owned list.
//
// A skin is just an ID string (e.g. "ring_ember", "title_voidwalker",
// "aura_satellite") — the frontend maps IDs to CSS effects. Follows the
// same pattern as /api/avatar and /api/username.
//
// Storage (Upstash Redis REST API via Vercel KV):
//   skin:<wallet>       -> currently equipped skin id
//   skinsowned:<wallet> -> JSON array of owned skin ids
//   skintx:<wallet>:<skinId> -> payment tx hash, stored for audit
//
// FREE_SKINS below must match the frontend's Forge catalog.
//
// ═══ CORRECTIFS (audit coûts & robustesse) ═══
//
// 1. GET ?wallet= : UN seul MGET au lieu de deux GET successifs.
//    Même réponse, moitié moins de commandes Redis.
// 2. GET ?stats=1 et GET ?wallet= : si Redis est indisponible, réponse 200
//    dégradée (skin:null / totalForged:0) au lieu d'un 500.
//
// 3. ACHATS VÉRIFIÉS SUR LA CHAÎNE. Avant, n'importe qui pouvait s'attribuer
//    un skin payant avec un faux hash de 64 caractères, ou avec tx:"feat".
//    Désormais, pour un skin payant, le serveur vérifie la transaction de
//    burn envoyée par le site (tx1 de skinBuy) :
//      · réussie, envoyée PAR ce wallet, VERS le contrat rituel ;
//      · montant au moins égal au plancher de la rareté (voir SKIN_MIN_BURN) ;
//      · récente (moins de 24 h) : un vieux burn ne peut pas servir d'achat ;
//      · jamais utilisée pour un autre achat (réservation unique du hash).
//    tx:"feat" n'est plus accepté que pour les skins de rareté "relic".
//    Aucun changement nécessaire côté site.
//
// ⚠️ Limites connues :
//    · La moitié envoyée à la trésorerie (tx2) n'est pas vérifiée : le site
//      n'envoie que le hash du burn. Le burn est la partie qui compte.
//    · Les reliques (feat) restent déclaratives : les hauts faits sont
//      calculés dans le navigateur. Impact limité aux reliques.
//    · Le catalogue SKIN_CATALOG doit rester aligné avec SKINS dans index.html.

const MAX_ID_LEN = 40;
const ID_REGEX = /^[a-zA-Z0-9_]+$/;
const TX_REGEX = /^0x[a-fA-F0-9]{64}$/;

const FREE_SKINS = ['ring_default'];

// Copie de SKINS (index.html) : id -> rareté. Un id absent est refusé.
const SKIN_CATALOG = {
  ring_default: 'default',
  ring_block: 'rare', ring_moon: 'rare', ring_halving: 'rare',
  ring_eclipse: 'epic', ring_bolt: 'epic', ring_mimble: 'epic',
  ring_trinity: 'legendary', ring_ember: 'legendary', ring_shadow: 'legendary',
  ring_devour: 'relic', ring_hollow: 'relic',
};

// ── Vérification on-chain ──────────────────────────────────────────────
const RPC_URL = 'https://liteforge.rpc.caldera.xyz/http';
const RITUAL_CONTRACT = '0x0ad3f776c45ff457d2d8e211a3174a4db201b656';

// Prix du site : SKIN_PRICE_USD = { rare: 2, epic: 3.5, legendary: 5 }, dont la
// MOITIÉ est brûlée. Le montant exact dépend du cours LTC au moment de
// l'achat, donc on vérifie un PLANCHER calculé pour un LTC à 400 $ : tant que
// le cours reste en dessous, tout achat honnête le dépasse. À relever si le
// cours dépasse durablement ce niveau.
const LTC_PRICE_CEILING_USD = 400;
const SKIN_PRICE_USD = { rare: 2, epic: 3.5, legendary: 5 };
const SKIN_MIN_BURN_WEI = Object.fromEntries(Object.entries(SKIN_PRICE_USD).map(
  ([r, usd]) => [r, BigInt(Math.floor((usd / LTC_PRICE_CEILING_USD / 2) * 1e18))]
));
const MAX_TX_AGE_S = 24 * 60 * 60;
const TX_USED_TTL_S = 400 * 24 * 60 * 60;

async function rpcBatch(reqs) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqs),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('RPC batch unsupported');
  return json.sort((a, b) => a.id - b.id).map(x => {
    if (x.error) throw new Error(x.error.message || 'RPC error');
    return x.result;
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/// Renvoie null si la transaction est un paiement valide, sinon la raison du refus.
async function verifyBurnTx(hash, walletKey, rarity) {
  let tx = null, receipt = null;
  // Le site attend tx.wait() avant d'appeler l'API, mais un nœud RPC peut
  // avoir un léger retard : quelques tentatives espacées.
  for (let i = 0; i < 4; i++) {
    [tx, receipt] = await rpcBatch([
      { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [hash] },
      { jsonrpc: '2.0', id: 2, method: 'eth_getTransactionReceipt', params: [hash] },
    ]);
    if (tx && receipt) break;
    await sleep(1500);
  }
  if (!tx || !receipt) return 'Transaction not found';
  if (receipt.status !== '0x1') return 'Transaction failed';
  if (String(tx.from).toLowerCase() !== walletKey) return 'Transaction not sent by this wallet';
  if (String(tx.to || '').toLowerCase() !== RITUAL_CONTRACT) return 'Transaction is not a ritual burn';
  if (BigInt(tx.value) < SKIN_MIN_BURN_WEI[rarity]) return 'Burn amount too low for this skin';

  const [block] = await rpcBatch([
    { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] },
  ]);
  const age = Math.floor(Date.now() / 1000) - Number(BigInt(block.timestamp));
  if (age > MAX_TX_AGE_S) return 'Transaction too old';
  return null;
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

function parseOwned(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function getOwned(walletKey) {
  const data = await redisCall(`/get/${encodeURIComponent('skinsowned:' + walletKey)}`, { method: 'GET' });
  return parseOwned(data.result);
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
        try {
          const data = await redisCall(`/get/${encodeURIComponent('skins:sold:total')}`, { method: 'GET' });
          res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
          res.status(200).json({ totalForged: Number(data.result) || 0 });
        } catch (e) {
          console.error('skin.js stats degraded:', e.message);
          res.setHeader('Cache-Control', 'public, s-maxage=10');
          res.status(200).json({ totalForged: 0, degraded: true });
        }
        return;
      }

      const { wallet } = req.query || {};
      if (!wallet) {
        res.status(400).json({ error: 'Missing wallet' });
        return;
      }
      const walletKey = String(wallet).toLowerCase();
      try {
        // Un seul aller-retour : [skin équipé, liste possédée]
        const data = await redisCall(
          `/mget/${encodeURIComponent('skin:' + walletKey)}/${encodeURIComponent('skinsowned:' + walletKey)}`,
          { method: 'GET' }
        );
        const vals = Array.isArray(data.result) ? data.result : [];
        res.status(200).json({ skin: vals[0] || null, owned: parseOwned(vals[1]) });
      } catch (e) {
        console.error('skin.js GET degraded:', e.message);
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({ skin: null, owned: [], degraded: true });
      }
      return;
    }

    if (req.method === 'POST') {
      const { wallet, skin, buy, tx } = req.body || {};
      if (!wallet) {
        res.status(400).json({ error: 'Missing wallet' });
        return;
      }
      const walletKey = String(wallet).toLowerCase();

      // ── BUY: record a purchase (or a feat unlock) ──
      if (buy) {
        if (buy.length > MAX_ID_LEN || !ID_REGEX.test(buy)) {
          res.status(400).json({ error: 'Invalid skin id' });
          return;
        }
        const rarity = SKIN_CATALOG[buy];
        if (!rarity || rarity === 'default') {
          res.status(400).json({ error: 'Unknown or non-purchasable skin' });
          return;
        }
        if (rarity === 'relic' ? tx !== 'feat' : !TX_REGEX.test(String(tx || ''))) {
          res.status(400).json({ error: rarity === 'relic' ? 'Relics are unlocked by feats' : 'Missing or invalid payment tx' });
          return;
        }

        const owned = await getOwned(walletKey);
        if (owned.includes(buy)) {
          res.status(200).json({ ok: true, owned });   // déjà possédé : rien à vérifier
          return;
        }

        if (rarity !== 'relic') {
          const hash = String(tx).toLowerCase();
          let reason;
          try {
            reason = await verifyBurnTx(hash, walletKey, rarity);
          } catch (e) {
            console.error('skin.js verify error:', e.message);
            // Chaîne injoignable : le joueur a payé, on lui demande de réessayer
            // plutôt que de refuser définitivement.
            res.status(503).json({ error: 'Could not verify payment right now, try again shortly' });
            return;
          }
          if (reason) {
            res.status(402).json({ error: reason });
            return;
          }
          // Un hash ne sert qu'à UN achat. SET NX : la première réservation gagne.
          const reserved = await redisCmd(['SET', `skintxused:${hash}`, `${walletKey}:${buy}`, 'NX', 'EX', String(TX_USED_TTL_S)]);
          if (reserved !== 'OK') {
            res.status(409).json({ error: 'This transaction was already used' });
            return;
          }
        }

        owned.push(buy);
        await redisCall(
          `/set/${encodeURIComponent('skinsowned:' + walletKey)}/${encodeURIComponent(JSON.stringify(owned.slice(0, 100)))}`,
          { method: 'POST' }
        );
        await redisCall(
          `/set/${encodeURIComponent('skintx:' + walletKey + ':' + buy)}/${encodeURIComponent(tx)}`,
          { method: 'POST' }
        );
        if (tx !== 'feat') {
          await redisCall(`/incr/${encodeURIComponent('skins:sold:total')}`, { method: 'POST' });
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
