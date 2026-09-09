// /api/leaderboard — classement des sacrifiants.
//
// ══════════════════════════════════════════════════════════════════════
// v12 — LECTURE DIRECTE DU STORAGE, CÔTÉ SERVEUR
// ══════════════════════════════════════════════════════════════════════
//
// TOUT LE RESTE A ÉTÉ ESSAYÉ ET A ÉCHOUÉ :
//
//   • Indexation des events via l'explorateur Blockscout (v5→v10). Fragile de
//     bout en bout — pages perdues, curseurs tronqués, verrou inopérant — elle
//     produisait des montants FAUX ET FIGÉS : un joueur affiché à 62.195 quand
//     la chaîne disait 90.2954, et des joueurs entiers absents du classement.
//     Depuis Vercel, l'explorateur part en TIMEOUT à chaque appel.
//
//   • getTopBurners() du contrat : "out of gas" même avec limit=1. Le tri
//     parcourt les 1841 burners quel que soit l'argument. Définitivement mort.
//
//   • eth_getLogs : timeout à 30 s dès 10 000 blocs sur ce RPC, et la chaîne
//     compte 33 M de blocs depuis le déploiement (bloc 15 063 366).
//
//   • Aucun accesseur public ne permet d'énumérer les burners.
//
// CE QUI MARCHE : le tableau des burners vit dans le storage du contrat, au
// SLOT 5 — vérifié, l'élément 0 est l'adresse du créateur. Solidity ne
// l'expose pas, eth_getStorageAt si. Pour un tableau dynamique, les éléments
// sont à keccak256(slot) + index.
//
// On lit donc les N adresses dans le storage, puis leurs montants avec
// getBurnerInfo. Les montants sont EXACTS PAR CONSTRUCTION : c'est le
// compteur interne du contrat, pas une somme reconstituée. Rien à indexer,
// rien qui puisse dériver.
//
// ── POURQUOI CÔTÉ SERVEUR ─────────────────────────────────────────────
//
// La v11 faisait cette lecture dans le navigateur. Ça marchait — puis le RPC
// a renvoyé des HTTP 429. Chaque visiteur déclenchait ~3700 appels, et le
// front s'actualise toutes les 60 s : à quelques visiteurs simultanés, le
// rate limit tombe et le classement disparaît pour tout le monde.
//
// Ici la lecture est faite UNE FOIS et mise en cache dans Redis. Mille
// visiteurs coûtent donc autant qu'un seul. C'est la seule forme viable.
//
// ── RÈGLES DE ROBUSTESSE ──────────────────────────────────────────────
//
// 1. Lots de 40, pas 200 : un lot de 200 était refusé d'un bloc par le RPC.
// 2. Pause entre les lots, et reprises avec attente progressive sur 429.
// 3. Le dernier classement RÉUSSI est conservé et servi si un cycle échoue.
//    Un classement d'il y a dix minutes vaut infiniment mieux qu'un tableau
//    vide — c'était le défaut majeur de toutes les versions précédentes.

// ─── CONFIG — à modifier au moment du passage au mainnet ───────────────
const RPC_URL = 'https://liteforge.rpc.caldera.xyz/http';
const CONTRACT_ADDRESS = '0x0AD3f776C45FF457d2d8e211A3174A4Db201b656';
const NETWORK_TAG = 'liteforge-v12';

/// Slot du tableau `burners` dans le storage. VÉRIFIÉ en lisant
/// keccak256(5)+0, qui renvoie l'adresse du créateur.
/// ⚠️ C'est une donnée d'IMPLÉMENTATION, pas une interface publique : un
/// redéploiement du contrat rituel avec les variables déclarées dans un autre
/// ordre changerait ce slot et casserait le classement. La correction durable
/// serait un getter public `burnerAt(uint256)` sur le contrat.
const BURNERS_ARRAY_SLOT = 5n;
// ─────────────────────────────────────────────────────────────────────

const SEL_BURNER_INFO = '0x39b7a75b';   // keccak("getBurnerInfo(address)")[0:4]
const SEL_BURNER_COUNT = '0xba8e15f1';  // keccak("getBurnerCount()")[0:4]

const BATCH_SIZE = 40;          // un lot de 200 se faisait refuser en bloc
const BATCH_PAUSE_MS = 120;     // respiration entre deux lots
const MAX_RETRIES = 4;
const RPC_TIMEOUT_MS = 15000;
const LEADERBOARD_SIZE = 100;

const FRESH_MS = 90000;         // au-delà, on relance une lecture
const INVOCATION_BUDGET_MS = 45000;

const KEY_DATA = `leaderboard:${NETWORK_TAG}:data`;
const KEY_LOCK = `leaderboard:${NETWORK_TAG}:lock`;

export const config = { maxDuration: 60 };

// ═══════════════════════════════════════════════════════════════════════
// Redis (Upstash REST) — format commande, sans rien à encoder dans l'URL
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
    // Silencieux : une clé absente est un cas normal (premier appel), pas
    // une erreur. Le vrai échec Redis, s'il y en a un, remonte plus loin
    // via les catch de tryLock()/readLeaderboard() qui, eux, loggent.
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

/// Un lot de requêtes JSON-RPC, avec reprises sur 429.
/// L'attente double à chaque tentative : c'est ce qui laisse au rate limit le
/// temps de se réarmer au lieu de le marteler.
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

/// keccak256(slot) — début du tableau dynamique dans le storage.
/// Calculé sans dépendance : keccak est réimplémenté ci-dessous, ce qui évite
/// d'embarquer ethers côté serveur pour une seule opération.
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

async function readLeaderboard(deadline) {
  // 1. Combien de burners ?
  const cntHex = await rpcSingle('eth_call',
    [{ to: CONTRACT_ADDRESS, data: SEL_BURNER_COUNT }, 'latest']);
  const count = Number(BigInt(cntHex));
  if (!count) return { list: [], count: 0 };

  const base = arrayBase(BURNERS_ARRAY_SLOT);

  // 2. Les adresses, depuis le storage.
  const addrs = [];
  for (let i = 0; i < count; i += BATCH_SIZE) {
    if (Date.now() > deadline) throw new Error('BUDGET_EPUISE');
    const reqs = [];
    for (let k = i; k < Math.min(i + BATCH_SIZE, count); k++) {
      reqs.push({ jsonrpc: '2.0', id: k, method: 'eth_getStorageAt',
        params: [CONTRACT_ADDRESS, '0x' + (base + BigInt(k)).toString(16), 'latest'] });
    }
    const res = await rpcBatch(reqs);
    for (const x of res) {
      if (x.error || !x.result || x.result.length !== 66) continue;
      const a = '0x' + x.result.slice(-40);
      if (a !== '0x' + '0'.repeat(40)) addrs.push(a.toLowerCase());
    }
    await sleep(BATCH_PAUSE_MS);
  }

  // 3. Les montants, depuis le compteur interne du contrat.
  const list = [];
  for (let i = 0; i < addrs.length; i += BATCH_SIZE) {
    if (Date.now() > deadline) throw new Error('BUDGET_EPUISE');
    const slice = addrs.slice(i, i + BATCH_SIZE);
    const reqs = slice.map((a, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call',
      params: [{ to: CONTRACT_ADDRESS,
                 data: SEL_BURNER_INFO + a.slice(2).padStart(64, '0') }, 'latest'] }));
    const res = await rpcBatch(reqs);
    for (const x of res) {
      if (x.error || !x.result || x.result.length < 66) continue;
      const v = BigInt('0x' + x.result.slice(2, 66));
      if (v > 0n) list.push({ address: slice[x.id], amount: v.toString() });
    }
    await sleep(BATCH_PAUSE_MS);
  }

  // Comparateur qui renvoie bien 0 sur égalité : il y a de vrais ex æquo à
  // 100.000, et un comparateur incohérent peut désordonner au-delà.
  list.sort((a, b) => {
    const d = BigInt(b.amount) - BigInt(a.amount);
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  });

  return { list: list.slice(0, LEADERBOARD_SIZE), count };
}

// ═══════════════════════════════════════════════════════════════════════
// Handler
// ═══════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const cached = await redisGet(KEY_DATA);
    const age = cached ? Date.now() - cached.t : Infinity;

    // Diagnostic : /api/leaderboard?debug=1&key=<DEBUG_KEY>
    //
    // CORRIGÉ — ce mode déclenchait un readLeaderboard() COMPLET à chaque
    // appel, sans verrou ni cache, contrairement au chemin normal. N'importe
    // qui pouvait appeler cette URL en boucle et forcer des lectures RPC
    // payantes en continu : c'est le suspect le plus probable derrière le
    // pic d'Observability Events (1.25M events pour 178K invocations,
    // ~7 events/appel — un ratio que la lecture normale, gardée par le
    // cache 90s et le verrou, ne peut pas produire seule).
    //
    // Deux garde-fous : protégé par une clé, et ne fait plus JAMAIS de
    // lecture RPC — il ne fait qu'inspecter l'état déjà en cache.
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
        slotBase: '0x' + arrayBase(BURNERS_ARRAY_SLOT).toString(16),
        top3: cached ? cached.leaderboard.slice(0, 3).map(e => e.address + ' = ' + e.amount) : [],
      };
      try { out.redis = await redisCmd(['PING']); } catch (e) { out.redisErr = e.message; }
      res.status(200).json(out);
      return;
    }

    // Cache frais : on sert directement, sans toucher au RPC.
    if (cached && age < FRESH_MS) {
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
      res.status(200).json({
        leaderboard: cached.leaderboard,
        totalBurners: cached.totalBurners,
        updatedAt: new Date(cached.t).toISOString(),
      });
      return;
    }

    // Une seule invocation relit à la fois : sans ce verrou, dix visiteurs
    // simultanés déclencheraient dix lectures et le 429 reviendrait aussitôt.
    let fresh = null;
    if (await tryLock()) {
      try {
        const started = Date.now();
        const r = await readLeaderboard(started + INVOCATION_BUDGET_MS);
        if (r.list.length > 0) {
          fresh = { t: Date.now(), leaderboard: r.list, totalBurners: r.count };
          await redisSet(KEY_DATA, fresh);
          // Pas de log de succès ici : ce chemin s'exécute à chaque
          // rafraîchissement de cache (toutes les ~90s sous trafic), ce qui
          // en fait à lui seul une source réguliere d'events. Le compte
          // final (r.list.length, r.count) reste lisible via ?debug=1.
        }
      } catch (e) {
        // On NE jette PAS le cache existant : un classement daté vaut
        // infiniment mieux qu'un tableau vide, et c'était le défaut majeur
        // de toutes les versions précédentes.
        console.error('lecture échouée, on garde le cache:', e.message);
      } finally {
        await unlock();
      }
    }

    const data = fresh || cached;
    if (data) {
      res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
      res.status(200).json({
        leaderboard: data.leaderboard,
        totalBurners: data.totalBurners,
        updatedAt: new Date(data.t).toISOString(),
        stale: !fresh,
      });
    } else {
      res.status(200).json({ leaderboard: [], totalBurners: 0, updatedAt: null, building: true });
    }
  } catch (e) {
    console.error('leaderboard.js:', e);
    res.status(500).json({ error: 'Server error' });
  }
}
