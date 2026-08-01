// /api/leaderboard — classement des sacrifiants, via l'API de l'explorateur.
//
// LE FRONT NE PARLE PLUS JAMAIS AU RPC. Il appelle cet endpoint, qui sert
// une liste déjà triée et calculée, mise en cache dans Redis.
//
// POURQUOI L'EXPLORATEUR PLUTÔT QUE LE RPC :
// Le RPC de ce testnet est pathologiquement lent pour eth_getLogs (des
// dizaines de secondes, souvent des timeouts). L'explorateur Blockscout a
// DÉJÀ indexé tous les events : on lui demande la liste des burns page par
// page et il répond vite. Rapide, fiable, zéro timeout.
//
// CONSTRUCTION INCRÉMENTALE (le point clé) :
// Il y a beaucoup plus d'events que ce qu'une seule invocation Vercel peut
// parcourir (chaque burner fait plusieurs burns ; des milliers d'events au
// total). Donc on parcourt les pages de l'explorateur PETIT À PETIT, sur
// plusieurs invocations : chaque appel reprend là où le précédent s'est
// arrêté (curseur next_page_params sauvegardé dans Redis), accumule les
// totaux par adresse, et sauvegarde.
//
// CORRECTIF IMPORTANT (v5) : la version précédente ne rafraîchissait le
// résultat SERVI au front qu'une fois un cycle ENTIER terminé (reachedEnd).
// Avec des centaines de pages à parcourir à 40/invocation, un cycle prend
// des dizaines d'appels — donc un burn tout frais pouvait rester invisible
// pendant très longtemps, alors que le scan progressait bien en coulisse.
// Désormais, chaque réponse FUSIONNE le dernier classement figé (KEY_FINAL)
// avec la progression du cycle en cours (KEY_PROGRESS) : un burn scanné
// dans les dernières pages apparaît donc dès l'appel suivant, sans attendre
// que tout le cycle boucle. KEY_FINAL n'est là que comme filet de sécurité
// pour ne jamais servir une liste vide entre deux cycles.
//
// CE QUE FAIT LE CONTRAT (event réellement émis, vu via l'explorateur) :
//   Burned(address indexed user, uint256 amount, uint256 date,
//          uint256 nonce, uint256 targetChainID)
//   -> `amount` = montant de CE burn, PAS un cumul. On SOMME par adresse.
//
// Stockage (Upstash Redis REST API via Vercel KV) :
//   leaderboard:<network>:progress -> { totals, cursor } accumulation en cours
//   leaderboard:<network>:final    -> { totals, updatedAt } dernier cycle COMPLET
//                                     (filet de sécurité, plus la seule source servie)
//   leaderboard:<network>:lock     -> verrou anti-invocations concurrentes
//
// Au passage mainnet : changez EXPLORER_BASE / CONTRACT_ADDRESS /
// NETWORK_TAG et tout repart proprement sur des clés fraîches.

// ─── CONFIG — à modifier au moment du passage au mainnet ───────────────
const EXPLORER_BASE = 'https://liteforge.explorer.caldera.xyz';
const CONTRACT_ADDRESS = '0x0AD3f776C45FF457d2d8e211A3174A4Db201b656';
const NETWORK_TAG = 'liteforge-testnet-v5';
// ─────────────────────────────────────────────────────────────────────

const BURN_TOPIC = '0xf1b8071d85a68dbc6b0a9b8ff17e44602315ec457cdf743f3eee37cf4a6dd38e';

const PAGES_PER_INVOCATION = 40;   // pages traitées à chaque appel (40×50 = 2000 events)
const FETCH_TIMEOUT_MS = 12000;    // par requête à l'explorateur
const INVOCATION_BUDGET_MS = 45000; // marge sous maxDuration=60 (Vercel Pro)

const KEY_PROGRESS = `leaderboard:${NETWORK_TAG}:progress`;
const KEY_FINAL = `leaderboard:${NETWORK_TAG}:final`;
const KEY_LOCK = `leaderboard:${NETWORK_TAG}:lock`;

export const config = { maxDuration: 60 };

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

async function redisGet(key) {
  try {
    const data = await redisCall(`/get/${encodeURIComponent(key)}`, { method: 'GET' });
    return data.result ? JSON.parse(data.result) : null;
  } catch { return null; }
}

async function redisSet(key, value) {
  await redisCall(
    `/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`,
    { method: 'POST' }
  );
}

async function tryAcquireLock() {
  try {
    const data = await redisCall(`/set/${encodeURIComponent(KEY_LOCK)}/1?NX=true&EX=55`, { method: 'POST' });
    return data.result === 'OK';
  } catch { return true; }
}

async function releaseLock() {
  try { await redisCall(`/del/${encodeURIComponent(KEY_LOCK)}`, { method: 'POST' }); } catch {}
}

function buildLeaderboard(totals) {
  const sorted = Object.entries(totals)
    .map(([address, total]) => ({ address, amount: String(total) }))
    .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1))
    .slice(0, 100);
  return {
    leaderboard: sorted,
    totalBurners: Object.keys(totals).length,
    updatedAt: new Date().toISOString(),
  };
}

// Fait avancer la construction d'un bloc de pages. Reprend le curseur
// sauvegardé, traite jusqu'à PAGES_PER_INVOCATION pages, resauvegarde.
// Si la fin des events est atteinte, fige KEY_FINAL (filet de sécurité)
// et réamorce un nouveau cycle propre à partir des mêmes totaux (on ne
// perd jamais ce qui a déjà été compté).
async function advance() {
  const started = Date.now();
  let progress = await redisGet(KEY_PROGRESS);
  let totals = {};
  if (progress && progress.totals) {
    for (const [a, v] of Object.entries(progress.totals)) totals[a] = BigInt(v);
  }
  let cursor = progress && progress.cursor ? progress.cursor : null;

  let reachedEnd = false;

  for (let i = 0; i < PAGES_PER_INVOCATION; i++) {
    if (Date.now() - started > INVOCATION_BUDGET_MS) break;

    const qs = new URLSearchParams({ topic0: BURN_TOPIC });
    if (cursor) {
      if (cursor.block_number != null) qs.set('block_number', String(cursor.block_number));
      if (cursor.index != null) qs.set('index', String(cursor.index));
      if (cursor.items_count != null) qs.set('items_count', String(cursor.items_count));
    }
    const url = `${EXPLORER_BASE}/api/v2/addresses/${CONTRACT_ADDRESS}/logs?${qs.toString()}`;

    let json;
    try {
      const res = await withTimeout(fetch(url, { headers: { Accept: 'application/json' } }), FETCH_TIMEOUT_MS);
      if (!res.ok) throw new Error(`explorer HTTP ${res.status}`);
      json = await res.json();
    } catch (err) {
      console.warn('leaderboard advance: page échouée:', err.message);
      break; // on garde l'accumulation ; prochaine invocation reprendra ce curseur
    }

    const items = Array.isArray(json.items) ? json.items : [];
    for (const it of items) {
      const params = it.decoded && Array.isArray(it.decoded.parameters) ? it.decoded.parameters : null;
      let addr = null, amount = null;
      if (params) {
        const pUser = params.find(p => p.name === 'user') || params.find(p => p.indexed && p.type === 'address');
        const pAmt = params.find(p => p.name === 'amount') || params.find(p => !p.indexed && p.type === 'uint256');
        if (pUser) addr = String(pUser.value).toLowerCase();
        if (pAmt) amount = pAmt.value;
      }
      if ((!addr || amount == null) && Array.isArray(it.topics) && it.topics[1]) {
        addr = ('0x' + String(it.topics[1]).slice(26)).toLowerCase();
        if (typeof it.data === 'string' && it.data.length >= 66) {
          amount = BigInt('0x' + it.data.slice(2, 66)).toString();
        }
      }
      if (!addr || amount == null) continue;
      try { totals[addr] = (totals[addr] || 0n) + BigInt(amount); } catch {}
    }

    cursor = json.next_page_params || null;
    if (!cursor) { reachedEnd = true; break; }
  }

  const totalsStr = {};
  for (const [a, v] of Object.entries(totals)) totalsStr[a] = v.toString();

  if (reachedEnd) {
    // Cycle complet : on fige KEY_FINAL comme filet de sécurité, et on
    // relance un nouveau cycle qui repart des MÊMES totaux (pas remis à
    // zéro) — un cycle sert à repasser sur tous les events pour capter
    // d'éventuels events manqués, pas à "oublier" ce qu'on sait déjà.
    await redisSet(KEY_FINAL, { totals: totalsStr, updatedAt: new Date().toISOString() });
    await redisSet(KEY_PROGRESS, { totals: totalsStr, cursor: null });
  } else {
    await redisSet(KEY_PROGRESS, { totals: totalsStr, cursor });
  }

  return totals; // toujours les totaux les plus frais connus après cet appel
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    let totals = null;

    // On tente de faire avancer la construction (un seul appel à la fois).
    // Si on obtient le verrou, advance() nous donne directement les
    // derniers totaux connus après ce pas de scan.
    const gotLock = await tryAcquireLock();
    if (gotLock) {
      try {
        totals = await advance();
      } catch (err) {
        console.error('leaderboard advance error:', err);
      } finally {
        await releaseLock();
      }
    }

    // Si on n'a pas pu avancer nous-mêmes (verrou pris par une autre
    // invocation simultanée), on lit la progression la plus récente
    // disponible plutôt que d'attendre : c'est ELLE qui contient les
    // burns les plus frais, pas KEY_FINAL qui peut dater d'un cycle entier.
    if (!totals) {
      const progress = await redisGet(KEY_PROGRESS);
      if (progress && progress.totals && Object.keys(progress.totals).length > 0) {
        totals = {};
        for (const [a, v] of Object.entries(progress.totals)) totals[a] = BigInt(v);
      }
    }

    // Filet de sécurité ultime : si aucune progression n'existe encore
    // (tout premier appel de tous, avant le premier scan), on retombe sur
    // le dernier cycle complet connu s'il existe.
    if (!totals) {
      const final = await redisGet(KEY_FINAL);
      if (final && final.totals) {
        totals = {};
        for (const [a, v] of Object.entries(final.totals)) totals[a] = BigInt(v);
      }
    }

    if (!totals || Object.keys(totals).length === 0) {
      res.status(200).json({ leaderboard: [], totalBurners: 0, updatedAt: null, building: true });
      return;
    }

    const payload = buildLeaderboard(totals);
    res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=60');
    res.status(200).json(payload);
  } catch (e) {
    console.error('leaderboard.js error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}
