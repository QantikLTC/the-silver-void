// /api/leaderboard — classement des sacrifiants, via l'API de l'explorateur.
//
// LE FRONT NE PARLE PLUS JAMAIS AU RPC. Il appelle cet endpoint, qui sert
// une liste déjà triée et calculée, mise en cache dans Redis.
//
// POURQUOI L'EXPLORATEUR PLUTÔT QUE LE RPC : voir historique du projet —
// le RPC testnet est trop lent/instable pour eth_getLogs ; l'explorateur
// Blockscout a déjà indexé tous les events et répond vite, page par page.
//
// CORRECTIF v6 — BUG CRITIQUE DE DOUBLE COMPTAGE CORRIGÉ :
// La v5 gardait les totaux accumulés d'un cycle terminé comme POINT DE
// DÉPART du cycle suivant, tout en repartant du curseur 0 (première page).
// Résultat : chaque nouveau cycle re-scannait les MÊMES events depuis le
// début et les rajoutait PAR-DESSUS des totaux qui les contenaient déjà.
// Les montants doublaient (ou pire) à chaque cycle complet — d'où les
// valeurs aberrantes (300+ zkLTC) constatées.
//
// RÈGLE FERME DÉSORMAIS : un cycle de scan est une reconstruction COMPLÈTE
// et INDÉPENDANTE depuis la première page. Ses totaux ne sont JAMAIS
// mélangés avec ceux d'un cycle précédent. Le "progress" en cours n'est
// JAMAIS servi au front tel quel (il est partiel/non fiable tant qu'il
// n'est pas fini) : seul le dernier cycle COMPLET et VALIDÉ (KEY_FINAL)
// est servi, jusqu'à ce que le cycle en cours se termine et le remplace
// intégralement.
//
// CE QUE FAIT LE CONTRAT (event réellement émis, vu via l'explorateur) :
//   Burned(address indexed user, uint256 amount, uint256 date,
//          uint256 nonce, uint256 targetChainID)
//   -> `amount` = montant de CE burn, PAS un cumul. On SOMME par adresse,
//      à l'intérieur d'un seul et même cycle, jamais entre deux cycles.
//
// Stockage (Upstash Redis REST API via Vercel KV) :
//   leaderboard:<network>:progress -> { totals, cursor } cycle EN COURS,
//                                     jamais servi tel quel au front
//   leaderboard:<network>:final    -> { totals, updatedAt } dernier cycle
//                                     COMPLET — c'est la SEULE source servie
//   leaderboard:<network>:lock     -> verrou anti-invocations concurrentes
//
// Au passage mainnet : changez EXPLORER_BASE / CONTRACT_ADDRESS /
// NETWORK_TAG et tout repart proprement sur des clés fraîches.

// ─── CONFIG — à modifier au moment du passage au mainnet ───────────────
const EXPLORER_BASE = 'https://liteforge.explorer.caldera.xyz';
const CONTRACT_ADDRESS = '0x0AD3f776C45FF457d2d8e211A3174A4Db201b656';
const NETWORK_TAG = 'liteforge-testnet-v6';
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

function buildLeaderboard(totalsStr, updatedAt) {
  const sorted = Object.entries(totalsStr)
    .map(([address, amount]) => ({ address, amount: String(amount) }))
    .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1))
    .slice(0, 100);
  return {
    leaderboard: sorted,
    totalBurners: Object.keys(totalsStr).length,
    updatedAt,
  };
}

// Fait avancer la construction d'un cycle. Reprend le curseur sauvegardé
// (progress), traite jusqu'à PAGES_PER_INVOCATION pages, resauvegarde.
// Si la fin des events est atteinte, le cycle est COMPLET : ses totaux
// remplacent intégralement KEY_FINAL, et un cycle TOUT NEUF (totaux vides,
// curseur nul) est amorcé pour la prochaine fois — jamais de mélange entre
// deux cycles.
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
    // Cycle COMPLET et fiable : il remplace intégralement KEY_FINAL.
    const updatedAt = new Date().toISOString();
    await redisSet(KEY_FINAL, { totals: totalsStr, updatedAt });
    // Nouveau cycle vierge — JAMAIS repartir des totaux qu'on vient de
    // figer, sinon le prochain passage les rescanne et les double.
    await redisSet(KEY_PROGRESS, { totals: {}, cursor: null });
    return { totalsStr, updatedAt, complete: true };
  } else {
    // Cycle encore incomplet : on sauvegarde la progression, mais on ne
    // la considère PAS comme un résultat fiable à afficher tel quel.
    await redisSet(KEY_PROGRESS, { totals: totalsStr, cursor });
    return { totalsStr: null, updatedAt: null, complete: false };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    // On tente de faire avancer le cycle en cours (un seul appel à la fois).
    const gotLock = await tryAcquireLock();
    if (gotLock) {
      try {
        await advance();
      } catch (err) {
        console.error('leaderboard advance error:', err);
      } finally {
        await releaseLock();
      }
    }

    // On sert TOUJOURS le dernier cycle COMPLET et validé (KEY_FINAL).
    // Jamais la progression d'un cycle en cours : elle est par nature
    // partielle tant qu'elle n'a pas atteint la fin des pages, et la
    // servir donnerait des totaux sous-évalués ou incohérents pendant
    // toute la durée de la reconstruction.
    const final = await redisGet(KEY_FINAL);
    if (final && final.totals && Object.keys(final.totals).length > 0) {
      res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=60');
      res.status(200).json(buildLeaderboard(final.totals, final.updatedAt));
    } else {
      const progress = await redisGet(KEY_PROGRESS);
      const partialCount = progress && progress.totals ? Object.keys(progress.totals).length : 0;
      res.status(200).json({ leaderboard: [], totalBurners: 0, updatedAt: null, building: true, partialCount });
    }
  } catch (e) {
    console.error('leaderboard.js error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}
