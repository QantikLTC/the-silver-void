// /api/leaderboard — classement des sacrifiants, via l'API de l'explorateur.
//
// LE FRONT NE PARLE PLUS JAMAIS AU RPC. Il appelle cet endpoint, qui sert
// une liste déjà triée et calculée, mise en cache dans Redis.
//
// POURQUOI L'EXPLORATEUR PLUTÔT QUE LE RPC :
// Le RPC de ce testnet (liteforge.rpc.caldera.xyz) est pathologiquement
// lent pour eth_getLogs — des dizaines de secondes par tranche, souvent
// des timeouts complets. Impossible de scanner ~750 burners comme ça.
// L'explorateur Blockscout, lui, a DÉJÀ indexé tous les events : on lui
// demande directement la liste des burns du contrat et il répond en une
// fraction de seconde, page par page. Rapide, fiable, zéro timeout.
//
// CE QUE FAIT LE CONTRAT (event réellement émis, vu via l'explorateur) :
//   Burned(address indexed user, uint256 amount, uint256 date,
//          uint256 nonce, uint256 targetChainID)
//   -> `amount` est le montant de CE burn précis, PAS un cumul.
//      Il faut donc SOMMER tous les `amount` par adresse pour obtenir
//      le total brûlé de chaque sacrifiant.
//
// L'explorateur renvoie les paramètres DÉJÀ DÉCODÉS (decoded.parameters),
// donc aucun décodage hex ni dépendance ethers n'est nécessaire ici.
//
// Stockage (Upstash Redis REST API via Vercel KV) :
//   leaderboard:<network>:data       -> JSON { leaderboard, totalBurners, updatedAt }
//   leaderboard:<network>:lock       -> verrou anti-recalculs concurrents
//
// Les clés sont préfixées par NETWORK_TAG : au passage mainnet, changez
// EXPLORER_BASE / CONTRACT_ADDRESS / NETWORK_TAG et le système repart sur
// des clés fraîches, sans mélanger avec les données testnet.

// ─── CONFIG — à modifier au moment du passage au mainnet ───────────────
const EXPLORER_BASE = 'https://liteforge.explorer.caldera.xyz';
const CONTRACT_ADDRESS = '0x0AD3f776C45FF457d2d8e211A3174A4Db201b656';
const NETWORK_TAG = 'liteforge-testnet-v3';
// ─────────────────────────────────────────────────────────────────────

// topic0 de l'event Burned — sert à ne demander QUE les burns à l'explorateur.
const BURN_TOPIC = '0xf1b8071d85a68dbc6b0a9b8ff17e44602315ec457cdf743f3eee37cf4a6dd38e';

// Garde-fous pour ne jamais boucler à l'infini ni dépasser le temps Vercel.
const MAX_PAGES = 200;             // 200 pages × 50 = 10 000 events max
const FETCH_TIMEOUT_MS = 12000;    // par requête à l'explorateur
const INVOCATION_BUDGET_MS = 50000; // marge sous maxDuration=60 (Vercel Pro)
// Durée de validité du cache : au-delà, un appel recalcule. Le cron
// rafraîchit de toute façon en arrière-plan, donc les visiteurs sont
// quasi toujours servis instantanément depuis le cache.
const CACHE_TTL_MS = 60000;

const KEY_DATA = `leaderboard:${NETWORK_TAG}:data`;
const KEY_LOCK = `leaderboard:${NETWORK_TAG}:lock`;

// Fonctions Vercel avec temps d'exécution étendu (plan Pro).
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

async function loadCache() {
  try {
    const data = await redisCall(`/get/${encodeURIComponent(KEY_DATA)}`, { method: 'GET' });
    return data.result ? JSON.parse(data.result) : null;
  } catch {
    return null;
  }
}

async function saveCache(payload) {
  await redisCall(
    `/set/${encodeURIComponent(KEY_DATA)}/${encodeURIComponent(JSON.stringify(payload))}`,
    { method: 'POST' }
  );
}

async function tryAcquireLock() {
  try {
    const data = await redisCall(`/set/${encodeURIComponent(KEY_LOCK)}/1?NX=true&EX=55`, { method: 'POST' });
    return data.result === 'OK';
  } catch {
    return true; // best-effort
  }
}

async function releaseLock() {
  try { await redisCall(`/del/${encodeURIComponent(KEY_LOCK)}`, { method: 'POST' }); } catch {}
}

// Récupère TOUS les events de burn via l'API paginée de l'explorateur,
// somme les montants par adresse, renvoie la liste triée décroissante.
async function rebuildFromExplorer() {
  const totals = {}; // adresse (lowercase) -> BigInt du total brûlé
  const started = Date.now();

  let pageParams = null; // next_page_params de la page précédente
  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() - started > INVOCATION_BUDGET_MS) {
      console.warn('leaderboard: budget temps atteint à la page', page);
      break;
    }

    const qs = new URLSearchParams({ topic0: BURN_TOPIC });
    if (pageParams) {
      if (pageParams.block_number != null) qs.set('block_number', String(pageParams.block_number));
      if (pageParams.index != null) qs.set('index', String(pageParams.index));
      if (pageParams.items_count != null) qs.set('items_count', String(pageParams.items_count));
    }
    const url = `${EXPLORER_BASE}/api/v2/addresses/${CONTRACT_ADDRESS}/logs?${qs.toString()}`;

    let json;
    try {
      const res = await withTimeout(fetch(url, { headers: { Accept: 'application/json' } }), FETCH_TIMEOUT_MS);
      if (!res.ok) throw new Error(`explorer HTTP ${res.status}`);
      json = await res.json();
    } catch (err) {
      console.warn('leaderboard: page', page, 'échouée:', err.message);
      break; // on garde ce qu'on a déjà accumulé
    }

    const items = Array.isArray(json.items) ? json.items : [];
    for (const it of items) {
      // Voie normale : paramètres déjà décodés par l'explorateur.
      const params = it.decoded && Array.isArray(it.decoded.parameters) ? it.decoded.parameters : null;
      let addr = null, amount = null;
      if (params) {
        const pUser = params.find(p => p.name === 'user') || params.find(p => p.indexed && p.type === 'address');
        const pAmt = params.find(p => p.name === 'amount') || params.find(p => !p.indexed && p.type === 'uint256');
        if (pUser) addr = String(pUser.value).toLowerCase();
        if (pAmt) amount = pAmt.value;
      }
      // Repli : décoder depuis topics/data bruts si jamais `decoded` manque.
      if ((!addr || amount == null) && Array.isArray(it.topics) && it.topics[1]) {
        addr = ('0x' + String(it.topics[1]).slice(26)).toLowerCase();
        if (typeof it.data === 'string' && it.data.length >= 66) {
          amount = BigInt('0x' + it.data.slice(2, 66)).toString();
        }
      }
      if (!addr || amount == null) continue;
      try {
        totals[addr] = (totals[addr] || 0n) + BigInt(amount);
      } catch { /* valeur non parseable : on ignore cet event */ }
    }

    pageParams = json.next_page_params || null;
    if (!pageParams) break; // dernière page atteinte
  }

  const sorted = Object.entries(totals)
    .map(([address, total]) => ({ address, amount: total.toString() }))
    .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1))
    .slice(0, 100);

  return {
    leaderboard: sorted,
    totalBurners: Object.keys(totals).length,
    updatedAt: new Date().toISOString(),
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const cached = await loadCache();
    const fresh = cached && cached.updatedAt &&
      (Date.now() - new Date(cached.updatedAt).getTime() < CACHE_TTL_MS);

    // Cache encore frais → on le sert directement, aucun recalcul.
    if (fresh) {
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
      res.status(200).json({ ...cached, cached: true });
      return;
    }

    // Cache périmé/absent : on tente de recalculer, mais un seul appel à la
    // fois (verrou). Les autres servent le cache périmé en attendant.
    const gotLock = await tryAcquireLock();
    if (!gotLock) {
      if (cached) {
        res.setHeader('Cache-Control', 'public, s-maxage=10');
        res.status(200).json({ ...cached, cached: true, stale: true });
        return;
      }
      res.status(200).json({ leaderboard: [], totalBurners: 0, updatedAt: null, building: true });
      return;
    }

    try {
      const payload = await rebuildFromExplorer();
      await saveCache(payload);
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
      res.status(200).json({ ...payload, cached: false });
    } finally {
      await releaseLock();
    }
  } catch (e) {
    console.error('leaderboard.js error:', e);
    const cached = await loadCache().catch(() => null);
    if (cached) { res.status(200).json({ ...cached, cached: true, error: true }); return; }
    res.status(500).json({ error: 'Server error' });
  }
}
