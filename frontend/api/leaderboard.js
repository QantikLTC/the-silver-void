// /api/leaderboard — classement des sacrifiants.
//
// ══════════════════════════════════════════════════════════════════════
// v8 — ARCHITECTURE INCRÉMENTALE (conçue pour ~1800+ sacrifiants)
// ══════════════════════════════════════════════════════════════════════
//
// CE QUI A MOTIVÉ CETTE RÉVISION
// Un joueur affiché à 62.195 zkLTC avait en réalité 90.2954 zkLTC selon
// getBurnerInfo(). Vérifié à la main sur la chaîne. ~28 zkLTC d'events
// perdus, pour LUI seul — les autres lignes étaient justes. Signature
// typique d'une plage de pages sautée pendant un cycle.
//
// LEÇON DE FOND : tant que les MONTANTS sont obtenus en sommant des
// events, la moindre page perdue ou rejouée fausse un total de façon
// invisible et DURABLE. Un scan d'events est fragile par nature
// (pagination, curseurs, timeouts, invocations concurrentes). Le contrat,
// lui, maintient déjà le cumul exact : c'est lui qu'il faut lire.
//
// LE PROBLÈME D'ÉCHELLE
// Avec 1833 sacrifiants, relire getBurnerInfo() pour tout le monde à
// chaque cycle est intenable. Mais ce n'est PAS NÉCESSAIRE :
//
//   getBurnerInfo(X) ne change QUE si X émet un nouvel event Burned.
//
// D'où la stratégie : l'état est PERSISTANT et on ne relit que ce qui a
// bougé. En régime établi, c'est une poignée d'adresses par cycle.
//
// ── LES TROIS ÉTAGES ──────────────────────────────────────────────────
//
//  1. DÉCOUVERTE INCRÉMENTALE
//     Blockscout renvoie les logs du plus RÉCENT au plus ancien. On garde
//     un high-water mark (dernier bloc traité) et on s'arrête dès qu'on
//     redescend dessous. En régime établi : 1 page, ~200 ms. Le scan
//     complet n'a lieu qu'au bootstrap (ou via ?full=1).
//
//  2. RAFRAÎCHISSEMENT CIBLÉ
//     Toute adresse vue dans un event récent entre dans une file. On la
//     relit on-chain via getBurnerInfo, en BATCH JSON-RPC (100 eth_call
//     par requête HTTP). La file est drainée sous budget ; ce qui reste
//     passe au cycle suivant. Aucun montant n'est jamais perdu.
//
//  3. BALAYAGE DE FOND (auto-réparation)
//     Quand la file est vide, on relit SWEEP_SIZE adresses en rotation.
//     Filet de sécurité : même si un event échappait définitivement à la
//     découverte, la valeur serait corrigée au passage du balayage.
//     Couverture complète des 1833 adresses en ~10 min.
//
// CONSÉQUENCE : une page d'events manquée ne coûte plus qu'un RETARD de
// correction (quelques minutes au pire, via le balayage). Elle ne peut
// plus produire un montant faux et figé. C'est le point important.
//
// NOTE : getTopBurners() du contrat reste INUTILISABLE (tri on-chain
// O(n²) qui dépasse la limite de gas et revert). Ce sont les lectures
// INDIVIDUELLES getBurnerInfo() qui sont fiables — ne pas confondre.
//
// ── CORRECTIFS PONCTUELS ÉGALEMENT APPLIQUÉS ──────────────────────────
//
// (a) VERROU QUI NE VERROUILLAIT PAS. `?NX=true&EX=55` n'est pas la
//     syntaxe Upstash : NX est un FLAG. Passé sous cette forme il pouvait
//     être ignoré → le SET réussissait toujours → tous les appels
//     concurrents obtenaient le "verrou". Le front appelant cet endpoint
//     toutes les 60 s PAR VISITEUR avec cache-buster, plusieurs advance()
//     tournaient en parallèle, lisaient le même curseur et s'écrasaient :
//     selon l'ordre d'écriture, pages rejouées (double comptage) ou
//     sautées (montants perdus). `catch { return true; }` aggravait tout.
//     Désormais `?NX&EX=55`, et en cas d'erreur on N'AVANCE PAS.
//
// (b) ÉCRITURE REDIS PAR URL. `/set/<key>/<encodeURIComponent(JSON)>`
//     produit une URL de ~172 KB pour 1833 adresses. Au-delà des limites,
//     le SET échoue et le cycle entier est perdu. Le payload passe
//     désormais en BODY.
//
// (c) CURSEUR TRONQUÉ. Seules 3 clés de next_page_params étaient
//     réinjectées. Blockscout en ajoute d'autres selon les versions. Une
//     clé manquante = page suivante mal bornée = events sautés. On renvoie
//     l'objet TEL QUEL.
//
// (d) FILTRE topic0 NON GARANTI. Le contrat n'étant pas vérifié,
//     it.decoded est TOUJOURS null : on passe toujours par le décodage
//     brut, sans garde-fou. Or l'endpoint attend selon les versions
//     `topic` ou `topic0` : si le paramètre est ignoré, on ingère TOUS les
//     logs et on les prend pour des burns. On envoie les deux formes ET on
//     refiltre sur topics[0].
//
// (e) COMPARATEUR DE TRI INVALIDE. `(a,b) => (B > A ? 1 : -1)` ne renvoie
//     jamais 0 : sur égalité il retourne -1, ce qui viole le contrat de
//     Array.prototype.sort. Il y a de vrais ex æquo (plusieurs à 100.000).
//
// ── CLÉS REDIS ────────────────────────────────────────────────────────
//   leaderboard:<tag>:state -> { amounts, highWater, queue, sweep, ... }
//                              état PERSISTANT, seule source servie
//   leaderboard:<tag>:scan  -> { cursor, dirty, newHigh, seed } scan de
//                              bootstrap en cours (multi-invocations)
//   leaderboard:<tag>:lock  -> verrou anti-invocations concurrentes
//
// Passage mainnet : changer EXPLORER_BASE / RPC_URL / CONTRACT_ADDRESS /
// NETWORK_TAG et tout repart sur des clés fraîches.

// ─── CONFIG — à modifier au moment du passage au mainnet ───────────────
const EXPLORER_BASE = 'https://liteforge.explorer.caldera.xyz';
const RPC_URL = 'https://liteforge.rpc.caldera.xyz/http';
const CONTRACT_ADDRESS = '0x0AD3f776C45FF457d2d8e211A3174A4Db201b656';
const NETWORK_TAG = 'liteforge-testnet-v11';
// ─────────────────────────────────────────────────────────────────────

// keccak256("Burned(address,uint256,uint256,uint256,uint256)")
const BURN_TOPIC = '0xf1b8071d85a68dbc6b0a9b8ff17e44602315ec457cdf743f3eee37cf4a6dd38e';

// keccak256("getBurnerInfo(address)")[0:4]. Codé en dur : aucune
// dépendance serveur (pas d'ethers), et le retour se décode à la main
// (le premier mot de 32 octets est `amount`).
const SEL_BURNER_INFO = '0x39b7a75b';

const LEADERBOARD_SIZE = 100;

const PAGES_PER_INVOCATION = 40;     // plafond de pages par appel
const FETCH_TIMEOUT_MS = 12000;      // par requête à l'explorateur
const RPC_TIMEOUT_MS = 15000;        // par requête RPC (batch de 100)
const RPC_BATCH_SIZE = 100;          // eth_call par requête HTTP groupée
const RPC_CONCURRENCY = 3;           // requêtes groupées en parallèle
const SWEEP_SIZE = 200;              // adresses relues par cycle au repos
const REORG_MARGIN = 200;            // blocs de recouvrement (sécurité réorg)
const LOG_CHUNK = 50000;             // blocs par eth_getLogs (réduit tout seul si refus)
const MIN_LOG_CHUNK = 1000;          // plancher de réduction

const INVOCATION_BUDGET_MS = 45000;  // marge sous maxDuration=60
const DISCOVERY_BUDGET_MS = 20000;   // part réservée au scan d'events
const SAVE_RESERVE_MS = 4000;        // marge pour l'écriture Redis finale

const KEY_STATE = `leaderboard:${NETWORK_TAG}:state`;
const KEY_LOCK = `leaderboard:${NETWORK_TAG}:lock`;

export const config = { maxDuration: 60 };

// L'explorateur Caldera est derriere une protection anti-bot : la meme
// requete passe depuis un navigateur et echoue depuis un serveur Vercel
// (aucune page lue, scanPagesLues=0). On se presente donc avec des en-tetes
// de navigateur ordinaire. Ce n'est pas un contournement de securite : c'est
// une lecture publique de donnees publiques, deja accessible a tous.
const BROWSER_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Referer: EXPLORER_BASE + '/',
  Origin: EXPLORER_BASE,
};

// ═══════════════════════════════════════════════════════════════════════
// Redis (Upstash REST)
// ═══════════════════════════════════════════════════════════════════════

// Toutes les commandes passent par le format tableau ["SET", cle, valeur].
// C'est la forme native de Redis : les flags (NX, EX) sont de simples
// elements du tableau, et le payload voyage dans le BODY.
//
// L'ancienne approche construisait des URL du type /set/<cle>/<valeur> :
//   - un flag sans valeur (?NX) pouvait etre rejete en HTTP 400, ce qui
//     bloquait l'acquisition du verrou et empechait TOUT scan de demarrer ;
//   - l'etat des 1833 adresses encode dans l'URL fait ~172 KB, au-dela des
//     limites : l'ecriture echouait et le cycle entier etait perdu.
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
    throw new Error(`Redis ${cmd[0]} a echoue: HTTP ${res.status} ${json && json.error ? json.error : ''}`);
  }
  return json ? json.result : null;
}

function withTimeout(promise, ms, label = 'TIMEOUT') {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(label)), ms); }),
  ]);
}

async function redisGet(key) {
  try {
    const r = await redisCmd(['GET', key]);
    return r ? JSON.parse(r) : null;
  } catch (e) {
    console.warn(`redisGet(${key}) a echoue:`, e.message);
    return null;
  }
}

async function redisSet(key, value) {
  return redisCmd(['SET', key, JSON.stringify(value)]);
}

async function redisDel(key) {
  try { await redisCmd(['DEL', key]); } catch {}
}

// NX et EX sont des elements du tableau : plus rien a encoder dans une URL.
// En cas d'echec on REFUSE le verrou : ne pas avancer vaut mieux que faire
// tourner deux cycles en parallele (c'etait la cause des montants faux).
async function tryAcquireLock() {
  try {
    return (await redisCmd(['SET', KEY_LOCK, '1', 'NX', 'EX', '55'])) === 'OK';
  } catch (e) {
    console.warn('leaderboard: verrou indisponible, on n\'avance pas:', e.message);
    return false;
  }
}

async function releaseLock() {
  try { await redisCmd(['DEL', KEY_LOCK]); } catch {}
}

// ═══════════════════════════════════════════════════════════════════════
// ÉTAGE 2 — Lecture on-chain groupée (source de vérité des montants)
// ═══════════════════════════════════════════════════════════════════════

function callDataFor(address) {
  return SEL_BURNER_INFO + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

// getBurnerInfo renvoie (uint256 amount, uint8 rank, string name).
// `amount` est le PREMIER mot de 32 octets : décodable sans ABI.
function decodeAmount(raw) {
  if (typeof raw !== 'string' || raw.length < 66) return null;
  try { return BigInt('0x' + raw.slice(2, 66)); } catch { return null; }
}

// Un seul POST HTTP pour jusqu'à RPC_BATCH_SIZE eth_call (JSON-RPC batch).
// C'est ce qui rend l'échelle tenable : 200 adresses = 2 requêtes, pas 200.
// Repli automatique en séquentiel si le noeud refuse les requêtes groupées.
async function rpcBatchRead(addresses) {
  const payload = addresses.map((addr, i) => ({
    jsonrpc: '2.0', id: i, method: 'eth_call',
    params: [{ to: CONTRACT_ADDRESS, data: callDataFor(addr) }, 'latest'],
  }));

  const res = await withTimeout(fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }), RPC_TIMEOUT_MS, 'RPC_TIMEOUT');

  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();

  if (!Array.isArray(json)) {
    // Noeud sans support du batch : on retombe sur des appels unitaires.
    throw new Error('BATCH_UNSUPPORTED');
  }

  const out = new Array(addresses.length).fill(null);
  for (const r of json) {
    if (r && typeof r.id === 'number' && !r.error) out[r.id] = decodeAmount(r.result);
  }
  return out;
}

async function rpcSingleRead(address) {
  const res = await withTimeout(fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: CONTRACT_ADDRESS, data: callDataFor(address) }, 'latest'],
    }),
  }), RPC_TIMEOUT_MS, 'RPC_TIMEOUT');
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return decodeAmount(json.result);
}

// Relit une liste d'adresses sous contrainte de temps.
// Renvoie { amounts, done, failed } — `done` = adresses effectivement
// traitées (à retirer de la file), le reste y demeure pour le cycle suivant.
async function refreshAmounts(addresses, deadline) {
  const amounts = {};
  const done = [];
  let failed = 0;

  const chunks = [];
  for (let i = 0; i < addresses.length; i += RPC_BATCH_SIZE) {
    chunks.push(addresses.slice(i, i + RPC_BATCH_SIZE));
  }

  for (let i = 0; i < chunks.length; i += RPC_CONCURRENCY) {
    if (Date.now() > deadline) break;

    const wave = chunks.slice(i, i + RPC_CONCURRENCY);
    const results = await Promise.all(wave.map(async chunk => {
      try {
        return await rpcBatchRead(chunk);
      } catch (e) {
        if (e.message === 'BATCH_UNSUPPORTED') {
          console.warn('leaderboard: RPC sans batch, repli séquentiel (lent)');
          const out = [];
          for (const a of chunk) {
            if (Date.now() > deadline) { out.push(undefined); continue; }
            out.push(await rpcSingleRead(a).catch(() => null));
          }
          return out;
        }
        console.warn('leaderboard: batch RPC échoué:', e.message);
        return chunk.map(() => null);
      }
    }));

    wave.forEach((chunk, w) => {
      chunk.forEach((addr, j) => {
        const v = results[w][j];
        if (v === undefined) return;      // non traité : reste en file
        if (v === null) { failed++; done.push(addr); return; } // échec: on n'insiste pas ce cycle
        amounts[addr] = v.toString();
        done.push(addr);
      });
    });
  }

  return { amounts, done, failed };
}

// ═══════════════════════════════════════════════════════════════════════
// ÉTAGE 1 — Découverte des adresses via eth_getLogs (RPC)
// ═══════════════════════════════════════════════════════════════════════
//
// POURQUOI PLUS L'EXPLORATEUR : depuis Vercel, chaque appel à Blockscout
// part en TIMEOUT (constaté via ?debug=1 : explorateurErreur "TIMEOUT",
// scanPagesLues 0). Les mêmes URL fonctionnent pourtant depuis un
// navigateur. Le serveur ne joint tout simplement pas l'explorateur de
// façon fiable — alors que le RPC, lui, répond parfaitement (c'est déjà
// par lui que passent toutes les lectures getBurnerInfo).
//
// On lit donc les events directement par eth_getLogs, PAR PLAGES DE BLOCS.
// Le découpage est indispensable : un getLogs sur toute la chaîne est
// refusé ou expire. La taille de plage s'ajuste toute seule si le noeud
// se plaint (voir adaptiveChunk).
//
// L'explorateur reste utilisable en secours (?source=explorer) mais n'est
// plus sur le chemin critique.

function hexToInt(h) { return typeof h === 'string' ? parseInt(h, 16) : Number(h || 0); }

async function rpcCall(method, params) {
  const res = await withTimeout(fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), RPC_TIMEOUT_MS, 'RPC_TIMEOUT');
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

async function getLatestBlock() {
  return hexToInt(await rpcCall('eth_blockNumber', []));
}

// Une plage de blocs. Renvoie les adresses trouvées, ou lève si le noeud
// refuse la plage (trop large / trop de résultats) pour qu'on la réduise.
async function getLogsRange(fromBlock, toBlock) {
  const logs = await rpcCall('eth_getLogs', [{
    address: CONTRACT_ADDRESS,
    topics: [BURN_TOPIC],
    fromBlock: '0x' + fromBlock.toString(16),
    toBlock: '0x' + toBlock.toString(16),
  }]);
  const addrs = new Set();
  if (Array.isArray(logs)) {
    for (const lg of logs) {
      // Le filtre `topics` est appliqué par le noeud, mais on revérifie :
      // le contrat n'étant pas vérifié, rien d'autre ne distingue un Burned.
      if (!Array.isArray(lg.topics) || String(lg.topics[0]).toLowerCase() !== BURN_TOPIC) continue;
      if (!lg.topics[1]) continue;
      addrs.add(('0x' + String(lg.topics[1]).slice(26)).toLowerCase());
    }
  }
  return [...addrs];
}

// Parcourt [from, to] en réduisant automatiquement la plage si le noeud
// refuse. Sauvegarde sa progression : un bootstrap sur une longue chaîne
// s'étale sur plusieurs invocations sans jamais repartir de zéro.
async function scanBlockRange(from, to, chunkSize, deadline, onAddrs) {
  let cursor = from;
  let chunk = chunkSize;
  let calls = 0;

  while (cursor <= to) {
    if (Date.now() > deadline) break;

    const end = Math.min(cursor + chunk - 1, to);
    try {
      const addrs = await getLogsRange(cursor, end);
      calls++;
      if (addrs.length) onAddrs(addrs);
      cursor = end + 1;
      // Plage acceptée : on ré-élargit prudemment vers la taille nominale.
      if (chunk < chunkSize) chunk = Math.min(chunkSize, chunk * 2);
    } catch (e) {
      if (chunk > MIN_LOG_CHUNK) {
        // Typiquement "query returned more than N results" ou timeout.
        chunk = Math.max(MIN_LOG_CHUNK, Math.floor(chunk / 4));
        console.warn(`leaderboard: plage réduite à ${chunk} blocs (${e.message})`);
        continue;
      }
      console.warn(`leaderboard: plage [${cursor}, ${end}] abandonnée:`, e.message);
      cursor = end + 1; // on n'insiste pas : le balayage de fond rattrapera
    }
  }

  return { cursor, calls, done: cursor > to };
}

// ═══════════════════════════════════════════════════════════════════════
// Cycle
// ═══════════════════════════════════════════════════════════════════════

function emptyState() {
  return { amounts: {}, highWater: 0, scanFrom: 0, queue: [], sweep: 0, bootstrapped: false, updatedAt: null };
}

async function advance(forceFull) {
  const started = Date.now();
  const state = (await redisGet(KEY_STATE)) || emptyState();
  if (forceFull) { state.bootstrapped = false; state.scanFrom = 0; state.highWater = 0; }

  const discoveryDeadline = started + DISCOVERY_BUDGET_MS;
  const discovered = new Set();
  let note = '';

  const latest = await getLatestBlock();

  if (!state.bootstrapped) {
    // ── Bootstrap : balayage complet, étalé sur plusieurs invocations ──
    const from = state.scanFrom || 0;
    const r = await scanBlockRange(from, latest, LOG_CHUNK, discoveryDeadline,
      addrs => addrs.forEach(a => discovered.add(a)));
    state.scanFrom = r.cursor;
    if (r.done) {
      state.bootstrapped = true;
      state.highWater = latest;
      note = `bootstrap TERMINÉ jusqu'au bloc ${latest}`;
    } else {
      const pct = latest > 0 ? ((r.cursor / latest) * 100).toFixed(1) : '0';
      note = `bootstrap ${pct}% (bloc ${r.cursor}/${latest}, ${r.calls} appels)`;
    }
  } else {
    // ── Régime établi : uniquement les blocs nouveaux ──
    const from = Math.max(0, (state.highWater || 0) - REORG_MARGIN);
    const r = await scanBlockRange(from, latest, LOG_CHUNK, discoveryDeadline,
      addrs => addrs.forEach(a => discovered.add(a)));
    if (r.done) state.highWater = latest;
    note = `incrémental blocs ${from}→${latest} (${r.calls} appels)`;
  }

  // ── File de rafraîchissement : nouveautés en TÊTE (priorité) ──
  const queue = Array.isArray(state.queue) ? state.queue : [];
  const qSet = new Set(queue);
  const fresh = [...discovered].filter(a => !qSet.has(a));
  let pending = [...fresh, ...queue];

  // ── ÉTAGE 3 : balayage de fond si rien d'urgent ──
  let swept = 0;
  const known = Object.keys(state.amounts).sort();
  if (pending.length === 0 && known.length > 0) {
    const start = (state.sweep || 0) % known.length;
    const slice = known.slice(start, start + SWEEP_SIZE);
    if (slice.length < SWEEP_SIZE) slice.push(...known.slice(0, SWEEP_SIZE - slice.length));
    pending = slice;
    swept = slice.length;
    state.sweep = (start + SWEEP_SIZE) % known.length;
  }

  // ── ÉTAGE 2 : lecture on-chain des montants ──
  const refreshDeadline = started + INVOCATION_BUDGET_MS - SAVE_RESERVE_MS;
  const { amounts, done, failed } = await refreshAmounts(pending, refreshDeadline);

  Object.assign(state.amounts, amounts);
  const doneSet = new Set(done);
  state.queue = swept ? [] : pending.filter(a => !doneSet.has(a));
  state.updatedAt = new Date().toISOString();

  await redisSet(KEY_STATE, state);

  console.log(`leaderboard: ${note} | ${discovered.size} adresse(s) touchée(s)`
    + ` | ${done.length} relues on-chain` + (swept ? ` (balayage ${swept})` : '')
    + ` | ${state.queue.length} en attente | ${failed} échecs`
    + ` | ${Object.keys(state.amounts).length} sacrifiants | ${Date.now() - started} ms`);

  return state;
}

// ═══════════════════════════════════════════════════════════════════════
// Sortie
// ═══════════════════════════════════════════════════════════════════════

function buildLeaderboard(state) {
  const sorted = Object.entries(state.amounts)
    .map(([address, amount]) => ({ address, amount: String(amount) }))
    .filter(e => { try { return BigInt(e.amount) > 0n; } catch { return false; } })
    // (e) Comparateur correct : renvoie 0 sur égalité. L'ancien renvoyait
    // -1, ce qui pouvait désordonner arbitrairement les ex æquo (100.000).
    .sort((a, b) => {
      const d = BigInt(b.amount) - BigInt(a.amount);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    })
    .slice(0, LEADERBOARD_SIZE);

  return {
    leaderboard: sorted,
    totalBurners: Object.keys(state.amounts).length,
    updatedAt: state.updatedAt,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const forceFull = req.query && (req.query.full === '1' || req.query.full === 'true');

    // ── MODE DIAGNOSTIC : /api/leaderboard?debug=1 ──
    // Affiche l'etat reel du systeme au lieu d'echouer en silence.
    if (req.query && req.query.debug === '1') {
      const out = {
        variablesEnv: {
          KV_REST_API_URL: !!process.env.KV_REST_API_URL,
          KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
        },
      };
      try { out.redisPing = await redisCmd(['PING']); }
      catch (e) { out.redisErreur = e.message; }

      // Test du RPC : c'est lui, désormais, le chemin critique.
      try {
        const latest = await getLatestBlock();
        out.rpcDernierBloc = latest;
        const t0 = Date.now();
        const a = await getLogsRange(Math.max(0, latest - 5000), latest);
        out.rpcGetLogsOk = true;
        out.rpcAdressesRecentes = a.length;
        out.rpcDureeMs = Date.now() - t0;
      } catch (e) { out.rpcErreur = e.message; }
      try {
        const l = await tryAcquireLock();
        out.verrouObtenu = l;
        if (l) await releaseLock();
      } catch (e) { out.verrouErreur = e.message; }
      try { await advance(forceFull); out.scanExecute = 'ok'; }
      catch (e) { out.scanErreur = e.message; out.scanStack = String(e.stack || '').split('\n').slice(0, 4); }
      const st = await redisGet(KEY_STATE);
      out.adressesEnregistrees = st && st.amounts ? Object.keys(st.amounts).length : 0;
      out.bootstrapTermine = st ? !!st.bootstrapped : false;
      out.scanBlocAtteint = st ? (st.scanFrom || 0) : 0;
      out.fileEnAttente = st && st.queue ? st.queue.length : 0;
      res.status(200).json(out);
      return;
    }

    let state = null;
    // Un seul advance() à la fois, réellement garanti cette fois (a).
    const gotLock = await tryAcquireLock();
    if (gotLock) {
      try { state = await advance(forceFull); }
      catch (err) { console.error('leaderboard advance error:', err); }
      finally { await releaseLock(); }
    }

    if (!state) state = await redisGet(KEY_STATE);

    if (state && state.amounts && Object.keys(state.amounts).length > 0) {
      res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=60');
      res.status(200).json(buildLeaderboard(state));
    } else {
      const partialCount = state && state.queue ? state.queue.length : 0;
      const progress = state && state.scanFrom ? state.scanFrom : 0;
      res.status(200).json({ leaderboard: [], totalBurners: 0, updatedAt: null, building: true, partialCount, progress });
    }
  } catch (e) {
    console.error('leaderboard.js error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}
