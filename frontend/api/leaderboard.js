// /api/leaderboard — cached, incrementally-updated leaderboard.
//
// LE FRONT NE PARLE PLUS JAMAIS AU RPC DIRECTEMENT. Il appelle cet
// endpoint, qui sert une liste déjà triée et calculée depuis Redis.
//
// Pourquoi "incrémental" : le RPC de ce testnet est très lent pour
// eth_getLogs (parfois des dizaines de secondes, parfois bloqué), et il
// y a des centaines de burners répartis sur des centaines de milliers de
// blocs. Un seul appel ne peut pas tout scanner avant que Vercel ne coupe
// la fonction. Donc chaque exécution scanne un morceau, là où la
// précédente s'est arrêtée, sauvegarde sa progression, et sert ce qui est
// déjà connu — qui devient de plus en plus complet au fil du temps.
//
// ASTUCE CLÉ : l'event Burned() du contrat contient déjà le total cumulé
// du burner (newBurnerTotal). Pas besoin d'appeler getBurnerInfo() par
// adresse après le scan — décoder l'event suffit.
//
// Stockage (Upstash Redis REST API via Vercel KV) :
//   leaderboard:<network>:amounts    -> JSON { "0xaddr": "montantWei", ... }
//   leaderboard:<network>:lastBlock  -> dernier bloc entièrement scanné
//   leaderboard:<network>:lock       -> verrou anti-scans concurrents
//   leaderboard:<network>:updatedAt  -> horodatage du dernier scan réussi
//
// Les clés sont préfixées par NETWORK_TAG : le jour du passage au
// mainnet, changez CONTRACT_ADDRESS / RPC / NETWORK_TAG (3 lignes) et le
// système repart sur des clés fraîches, sans mélanger avec les données
// testnet.

import { ethers } from 'ethers';

// ─── CONFIG — à modifier au moment du passage au mainnet ───────────────
const RPC = 'https://liteforge.rpc.caldera.xyz/http';
const CONTRACT_ADDRESS = '0x0AD3f776C45FF457d2d8e211A3174A4Db201b656';
const NETWORK_TAG = 'liteforge-testnet'; // ex: 'litecoin-mainnet' au mainnet
// Bloc à partir duquel scanner. Sur testnet on part de 0 (le scan
// incrémental rattrapera tout seul). Au mainnet, notez le bloc de
// déploiement du contrat dès que vous le déployez et mettez-le ici —
// ça évite de scanner des tranches vides avant que le contrat existe.
const START_BLOCK = 0;
// ─────────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 10000;          // plage max acceptée par ce RPC
const PER_CHUNK_TIMEOUT_MS = 7000; // ce RPC peut bloquer indéfiniment sans ça
const INVOCATION_BUDGET_MS = 50000; // marge de 10s sous maxDuration=60 (Vercel Pro)

const KEY_AMOUNTS = `leaderboard:${NETWORK_TAG}:amounts`;
const KEY_LASTBLOCK = `leaderboard:${NETWORK_TAG}:lastBlock`;
const KEY_LOCK = `leaderboard:${NETWORK_TAG}:lock`;
const KEY_UPDATED = `leaderboard:${NETWORK_TAG}:updatedAt`;

const IFACE = new ethers.Interface([
  'event Burned(address indexed burner, uint256 amount, uint256 newBurnerTotal, uint256 globalTotal, uint256 timestamp)'
]);
const BURN_TOPIC = IFACE.getEvent('Burned').topicHash;

// Fonctions Vercel avec un temps d'exécution étendu (nécessite le plan Pro).
export const config = {
  maxDuration: 60,
};

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

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms)),
  ]);
}

async function tryAcquireLock() {
  // SET key 1 NX EX 15 — une seule invocation scanne à la fois.
  try {
    const data = await redisCall(`/set/${encodeURIComponent(KEY_LOCK)}/1?NX=true&EX=15`, { method: 'POST' });
    return data.result === 'OK';
  } catch {
    return true; // best-effort : ne pas bloquer le scan si le verrou échoue
  }
}

async function releaseLock() {
  try { await redisCall(`/del/${encodeURIComponent(KEY_LOCK)}`, { method: 'POST' }); } catch {}
}

async function loadState() {
  const data = await redisCall(
    '/mget/' + [KEY_AMOUNTS, KEY_LASTBLOCK].map(encodeURIComponent).join('/'),
    { method: 'GET' }
  );
  const [amountsRaw, lastBlockRaw] = Array.isArray(data.result) ? data.result : [null, null];
  let amounts = {};
  try { amounts = amountsRaw ? JSON.parse(amountsRaw) : {}; } catch {}
  const lastBlock = lastBlockRaw ? Number(lastBlockRaw) : START_BLOCK - 1;
  return { amounts, lastBlock };
}

async function saveState(amounts, lastBlock) {
  await redisCall(
    `/set/${encodeURIComponent(KEY_AMOUNTS)}/${encodeURIComponent(JSON.stringify(amounts))}`,
    { method: 'POST' }
  );
  await redisCall(
    `/set/${encodeURIComponent(KEY_LASTBLOCK)}/${encodeURIComponent(String(lastBlock))}`,
    { method: 'POST' }
  );
  await redisCall(
    `/set/${encodeURIComponent(KEY_UPDATED)}/${encodeURIComponent(new Date().toISOString())}`,
    { method: 'POST' }
  );
}

async function scanIncremental() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const { amounts, lastBlock } = await loadState();

  const latest = await withTimeout(provider.getBlockNumber(), PER_CHUNK_TIMEOUT_MS);
  let from = lastBlock + 1;
  const invocationStart = Date.now();
  let scannedAny = false;

  while (from <= latest && (Date.now() - invocationStart) < INVOCATION_BUDGET_MS) {
    const to = Math.min(from + CHUNK_SIZE - 1, latest);
    try {
      const logs = await withTimeout(
        provider.getLogs({ address: CONTRACT_ADDRESS, topics: [BURN_TOPIC], fromBlock: from, toBlock: to }),
        PER_CHUNK_TIMEOUT_MS
      );
      for (const log of logs) {
        const parsed = IFACE.parseLog(log);
        const addr = parsed.args.burner.toLowerCase();
        amounts[addr] = parsed.args.newBurnerTotal.toString();
      }
      scannedAny = true;
      from = to + 1;
    } catch (err) {
      // Cette tranche a timeout ou échoué (RPC capricieux). On s'arrête
      // ici — la progression déjà faite est sauvegardée ci-dessous, et
      // la prochaine exécution reprendra exactement au même endroit.
      console.warn('leaderboard scan: chunk', from, '-', to, 'failed:', err.message);
      break;
    }
  }

  if (scannedAny) {
    await saveState(amounts, from - 1);
  }
  return { amounts, lastBlock: from - 1, latest, complete: from > latest };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    let amounts, lastBlock, complete;
    const gotLock = await tryAcquireLock();

    if (gotLock) {
      try {
        const result = await scanIncremental();
        amounts = result.amounts;
        lastBlock = result.lastBlock;
        complete = result.complete;
      } finally {
        await releaseLock();
      }
    } else {
      // Un autre appel est en train de scanner — on sert le cache tel quel.
      const state = await loadState();
      amounts = state.amounts;
      lastBlock = state.lastBlock;
      complete = null; // inconnu sans un nouvel appel getBlockNumber
    }

    const sorted = Object.entries(amounts)
      .map(([address, amount]) => ({ address, amount }))
      .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1))
      .slice(0, 100);

    res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=120');
    res.status(200).json({
      leaderboard: sorted,
      totalBurners: Object.keys(amounts).length,
      lastBlock,
      complete,
    });
  } catch (e) {
    console.error('leaderboard.js error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}
