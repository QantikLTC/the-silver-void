// /api/leaderboard — classement des sacrifiants.
//
// ══════════════════════════════════════════════════════════════════════
// v12.1 — LECTURE DIRECTE DU STORAGE, CÔTÉ SERVEUR
// ══════════════════════════════════════════════════════════════════════
//
// (Historique v5 → v12 inchangé : Blockscout, getTopBurners() et eth_getLogs
// ont échoué ; le tableau des burners est lu au SLOT 5 du storage, puis les
// montants via getBurnerInfo. La lecture est faite une fois et mise en cache
// dans Redis, pour que mille visiteurs coûtent autant qu'un seul.)
//
// ═══ CORRECTIFS v12.1 (audit coûts & robustesse) ═══
//
// 1. BUG : `started` était déclaré DANS le try, puis utilisé dans le catch.
//    En JavaScript, une const déclarée dans un bloc n'existe pas dans le catch
//    voisin : toute lecture échouée levait donc une ReferenceError dans le
//    catch lui-même. Résultat, l'erreur remontait jusqu'au handler, qui
//    répondait 500 « Server error » au lieu de servir le cache conservé —
//    exactement le scénario que la règle 3 devait empêcher.
//
// 2. PAUSE APRÈS ÉCHEC. Avant, une lecture ratée libérait le verrou aussitôt :
//    la requête suivante relançait une lecture complète (jusqu'à 52 s de
//    fonction et ~95 lots RPC), et ainsi de suite en boucle tant que la
//    lecture échouait (RPC saturé, ou trop de burners pour le budget). Le
//    verrou est désormais conservé 5 minutes après un échec : on sert le
//    cache pendant ce temps, sans aucune lecture ni commande supplémentaire.
//
// ⚠️ À SURVEILLER : le temps de lecture grandit avec le nombre de burners.
//    Si les logs montrent des BUDGET_EPUISE réguliers, la prochaine étape est
//    de mémoriser les adresses déjà lues (le tableau ne fait que grandir) et
//    de ne relire que les nouvelles, ce qui divise la lecture par deux.

// ─── CONFIG — à modifier au moment du passage au mainnet ───────────────
const RPC_URL = 'https://liteforge.rpc.caldera.xyz/http';
const CONTRACT_ADDRESS = '0x8A64B46634B26D5E4fcfcD8167379546A353Aaf6';   // Rituel v2
const NETWORK_TAG = 'liteforge-v2';   // cache distinct de l'ancien Rituel, même si la base Upstash est partagée

/// Slot du tableau `burners` dans le storage. VÉRIFIÉ en lisant
/// keccak256(5)+0, qui renvoie l'adresse du créateur.
/// ⚠️ Donnée d'IMPLÉMENTATION : un redéploiement du contrat avec les variables
/// dans un autre ordre changerait ce slot. Correction durable : un getter
/// public `burnerAt(uint256)` sur le contrat.
const BURNERS_ARRAY_SLOT = 5n;
// ─────────────────────────────────────────────────────────────────────

const SEL_BURNER_INFO = '0x39b7a75b';   // keccak("getBurnerInfo(address)")[0:4]
const SEL_BURNER_COUNT = '0xba8e15f1';
const SEL_BURNERS_PAGE = '0xe1246167';   // keccak("burnersPage(uint256,uint256)")[0:4]
const PAGE_SIZE = 200;                     // plafond du contrat  // keccak("getBurnerCount()")[0:4]

const BATCH_SIZE = 40;
const BATCH_PAUSE_MS = 60;
const MAX_RETRIES = 4;
const RPC_TIMEOUT_MS = 15000;
const LEADERBOARD_SIZE = 100;
const CONCURRENCY = 3;

const FRESH_MS = 300000;
const INVOCATION_BUDGET_MS = 52000;   // maxDuration vaut 60 s

/// Durée pendant laquelle aucune nouvelle lecture n'est tentée après un échec.
const FAIL_COOLDOWN_S = 300;

const KEY_DATA = `leaderboard:${NETWORK_TAG}:data`;
const KEY_LOCK = `leaderboard:${NETWORK_TAG}:lock`;

export const config = { maxDuration: 60 };

// ═══════════════════════════════════════════════════════════════════════
// Redis (Upstash REST)
// ═══════════════════════════════════════════════════════════════════════

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

async function redisGet(key) {
  try {
    const r = await redisCmd(['GET', key]);
    return r ? JSON.parse(r) : null;
  } catch (e) {
    return null;
  }
}

async function redisSet(key, value) {
  return redisCmd(['SET', key, JSON.stringify(value)]);
}

async function tryLock() {
  try {
    return (await redisCmd(['SET', KEY_LOCK, '1', 'NX', 'EX', '55'])) === 'OK';
  } catch (e) {
    console.warn('verrou indisponible:', e.message);
    return false;
  }
}

async function unlock() {
  try { await redisCmd(['DEL', KEY_LOCK]); } catch {}
}

/// Après un échec : on garde le verrou, prolongé, au lieu de le libérer.
async function holdLockAfterFailure() {
  try { await redisCmd(['SET', KEY_LOCK, 'cooldown', 'EX', String(FAIL_COOLDOWN_S)]); } catch {}
}

// ═══════════════════════════════════════════════════════════════════════
// RPC
// ═══════════════════════════════════════════════════════════════════════

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error('RPC_TIMEOUT')), ms); }),
  ]);
}

async function rpcBatch(reqs) {
  let wait = 400;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await withTimeout(fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqs),
      }), RPC_TIMEOUT_MS);

      if (res.status === 429) {
        if (attempt === MAX_RETRIES) throw new Error('RATE_LIMITED');
        await sleep(wait); wait *= 2;
        continue;
      }
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);

      const json = await res.json();
      if (!Array.isArray(json)) throw new Error('BATCH_UNSUPPORTED');
      return json;
    } catch (e) {
      if (attempt === MAX_RETRIES) throw e;
      await sleep(wait); wait *= 2;
    }
  }
  throw new Error('unreachable');
}

async function rpcSingle(method, params) {
  const [r] = await rpcBatch([{ jsonrpc: '2.0', id: 0, method, params }]);
  if (r.error) throw new Error(r.error.message);
  return r.result;
}

// ═══════════════════════════════════════════════════════════════════════
// Lecture du classement
// ═══════════════════════════════════════════════════════════════════════

function arrayBase(slot) {
  const buf = new Uint8Array(32);
  let v = slot;
  for (let i = 31; i >= 0 && v > 0n; i--) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return BigInt('0x' + keccak256(buf));
}

// ─── keccak256 minimal (suffisant pour 32 octets) ─────────────────────
const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const KECCAK_ROT = [
   0n, 1n, 62n, 28n, 27n, 36n, 44n,  6n, 55n, 20n,  3n, 10n, 43n,
  25n, 39n, 41n, 45n, 15n, 21n,  8n, 18n,  2n, 61n, 56n, 14n,
];
const M64 = 0xffffffffffffffffn;
const rotl = (x, n) => ((x << n) | (x >> (64n - n))) & M64;

function keccakF(S) {
  for (let r = 0; r < 24; r++) {
    const C = new Array(5);
    for (let x = 0; x < 5; x++) C[x] = S[x] ^ S[x+5] ^ S[x+10] ^ S[x+15] ^ S[x+20];
    for (let x = 0; x < 5; x++) {
      const D = C[(x+4)%5] ^ rotl(C[(x+1)%5], 1n);
      for (let y = 0; y < 25; y += 5) S[x+y] ^= D;
    }
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
      B[y + 5*((2*x + 3*y) % 5)] = rotl(S[x + 5*y], KECCAK_ROT[x + 5*y]);
    }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
      S[x + 5*y] = B[x + 5*y] ^ ((~B[(x+1)%5 + 5*y] & M64) & B[(x+2)%5 + 5*y]);
    }
    S[0] ^= KECCAK_RC[r];
  }
}

function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(rate);
  padded.set(bytes.slice(0, rate));
  padded[bytes.length] = 0x01;
  padded[rate - 1] |= 0x80;

  const S = new Array(25).fill(0n);
  for (let i = 0; i < rate / 8; i++) {
    let lane = 0n;
    for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[i*8 + b]);
    S[i] ^= lane;
  }
  keccakF(S);

  let out = '';
  for (let i = 0; i < 4; i++) {
    let lane = S[i];
    for (let b = 0; b < 8; b++) {
      out += (Number(lane & 0xffn)).toString(16).padStart(2, '0');
      lane >>= 8n;
    }
  }
  return out;
}
// ──────────────────────────────────────────────────────────────────────

// Rituel v2 : une seule fonction, burnersPage(), rend 200 burners et leurs
// montants à la fois. Plus besoin de lire le stockage case par case ni de
// rappeler getBurnerInfo() pour chaque adresse : ~10 appels pour 2 000 burners.
function word(hex, i) { return hex.slice(2 + i * 64, 2 + (i + 1) * 64); }

function decodePage(hex) {
  // (address[] addresses, uint256[] amounts, uint256 nextCursor)
  const offA = Number(BigInt('0x' + word(hex, 0))) / 32;
  const offB = Number(BigInt('0x' + word(hex, 1))) / 32;
  const next = Number(BigInt('0x' + word(hex, 2)));
  const nA = Number(BigInt('0x' + word(hex, offA)));
  const nB = Number(BigInt('0x' + word(hex, offB)));
  const out = [];
  for (let k = 0; k < Math.min(nA, nB); k++) {
    const addr = '0x' + word(hex, offA + 1 + k).slice(24);
    const amt = BigInt('0x' + word(hex, offB + 1 + k));
    out.push({ address: addr.toLowerCase(), amount: amt });
  }
  return { rows: out, next };
}

async function readLeaderboard(deadline) {
  const cntHex = await rpcSingle('eth_call',
    [{ to: CONTRACT_ADDRESS, data: SEL_BURNER_COUNT }, 'latest']);
  const count = Number(BigInt(cntHex));
  if (!count) return { list: [], count: 0 };

  const list = [];
  let cursor = 0, guard = 0;
  do {
    if (Date.now() > deadline) throw new Error('BUDGET_EPUISE');
    const data = SEL_BURNERS_PAGE + cursor.toString(16).padStart(64, '0') + PAGE_SIZE.toString(16).padStart(64, '0');
    const hex = await rpcSingle('eth_call', [{ to: CONTRACT_ADDRESS, data }, 'latest']);
    const { rows, next } = decodePage(hex);
    for (const r of rows) if (r.amount > 0n) list.push({ address: r.address, amount: r.amount.toString() });
    cursor = next;
    guard++;
    if (cursor) await sleep(BATCH_PAUSE_MS);
  } while (cursor && guard < 500);

  list.sort((a, b) => {
    const d = BigInt(b.amount) - BigInt(a.amount);
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  });

  return { list: list.slice(0, LEADERBOARD_SIZE), count };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const cached = await redisGet(KEY_DATA);
    const age = cached ? Date.now() - cached.t : Infinity;

    // Diagnostic : /api/leaderboard?debug=1&key=<DEBUG_KEY> — protégé par clé,
    // n'effectue jamais de lecture RPC.
    if (req.query && req.query.debug === '1') {
      if (!process.env.DEBUG_KEY || req.query.key !== process.env.DEBUG_KEY) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const out = {
        env: { url: !!process.env.KV_REST_API_URL, token: !!process.env.KV_REST_API_TOKEN },
        cacheAgeSec: cached ? Math.round(age / 1000) : null,
        cacheEntries: cached ? cached.leaderboard.length : 0,
        cacheStale: cached ? age >= FRESH_MS : null,
        burnersInCache: cached ? cached.totalBurners : null,
        estimatedBatches: cached ? Math.ceil(cached.totalBurners / BATCH_SIZE) * 2 : null,
        slotBase: '0x' + arrayBase(BURNERS_ARRAY_SLOT).toString(16),
        top3: cached ? cached.leaderboard.slice(0, 3).map(e => e.address + ' = ' + e.amount) : [],
      };
      try { out.redis = await redisCmd(['PING']); } catch (e) { out.redisErr = e.message; }
      try { out.lock = await redisCmd(['GET', KEY_LOCK]); } catch {}
      res.status(200).json(out);
      return;
    }

    if (cached && age < FRESH_MS) {
      res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
      res.status(200).json({
        leaderboard: cached.leaderboard,
        totalBurners: cached.totalBurners,
        updatedAt: new Date(cached.t).toISOString(),
      });
      return;
    }

    let fresh = null;
    if (await tryLock()) {
      const started = Date.now();   // hors du try : visible dans le catch
      let failed = false;
      try {
        const r = await readLeaderboard(started + INVOCATION_BUDGET_MS);
        if (r.list.length > 0) {
          fresh = { t: Date.now(), leaderboard: r.list, totalBurners: r.count };
          await redisSet(KEY_DATA, fresh);
        }
      } catch (e) {
        failed = true;
        console.error(`lecture échouée après ${Date.now() - started}ms, cache conservé, pause ${FAIL_COOLDOWN_S}s:`, e.message);
      } finally {
        if (failed) await holdLockAfterFailure();
        else await unlock();
      }
    }

    const data = fresh || cached;
    if (data) {
      res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=600');
      res.status(200).json({
        leaderboard: data.leaderboard,
        totalBurners: data.totalBurners,
        updatedAt: new Date(data.t).toISOString(),
        stale: !fresh,
      });
    } else {
      res.setHeader('Cache-Control', 'public, s-maxage=30');
      res.status(200).json({ leaderboard: [], totalBurners: 0, updatedAt: null, building: true });
    }
  } catch (e) {
    console.error('leaderboard.js:', e);
    res.status(500).json({ error: 'Server error' });
  }
}
