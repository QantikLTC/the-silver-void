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
const NETWORK_TAG = 'liteforge-testnet-v10';
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
const REORG_MARGIN = 50;             // blocs de recouvrement (sécurité réorg)

const INVOCATION_BUDGET_MS = 45000;  // marge sous maxDuration=60
const DISCOVERY_BUDGET_MS = 20000;   // part réservée au scan d'events
const SAVE_RESERVE_MS = 4000;        // marge pour l'écriture Redis finale

const KEY_STATE = `leaderboard:${NETWORK_TAG}:state`;
const KEY_SCAN = `leaderboard:${NETWORK_TAG}:scan`;
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
// ÉTAGE 1 — Découverte des adresses via les events
// ═══════════════════════════════════════════════════════════════════════

function extractBurn(it) {
  // (d) Garde-fou indispensable : le contrat n'étant pas vérifié,
  // it.decoded est toujours null et rien ne distingue un Burned d'un autre
  // event si le filtre serveur a été ignoré.
  if (!Array.isArray(it.topics) || !it.topics[0]) return null;
  if (String(it.topics[0]).toLowerCase() !== BURN_TOPIC) return null;

  let addr = null, amount = null;

  // Chemin nominal si le contrat est un jour vérifié.
  const params = it.decoded && Array.isArray(it.decoded.parameters) ? it.decoded.parameters : null;
  if (params) {
    const pUser = params.find(p => p.name === 'user') || params.find(p => p.indexed && p.type === 'address');
    const pAmt = params.find(p => p.name === 'amount') || params.find(p => !p.indexed && p.type === 'uint256');
    if (pUser) addr = String(pUser.value).toLowerCase();
    if (pAmt) amount = pAmt.value;
  }

  // Chemin brut (celui réellement emprunté aujourd'hui) : `user` est le
  // seul paramètre indexé -> topics[1] ; `amount` est le premier mot non
  // indexé -> 32 premiers octets du data.
  if ((!addr || amount == null) && it.topics[1]) {
    addr = ('0x' + String(it.topics[1]).slice(26)).toLowerCase();
    if (typeof it.data === 'string' && it.data.length >= 66) {
      amount = BigInt('0x' + it.data.slice(2, 66)).toString();
    }
  }

  if (!addr || amount == null) return null;
  return { addr, amount, block: Number(it.block_number ?? it.blockNumber ?? 0) };
}

async function fetchLogsPage(cursor) {
  const qs = new URLSearchParams();
  // Seul `topic0` est envoye. La double graphie precedente (`topic` ET
  // `topic0`) etait une precaution inutile : le filtrage reel se fait de
  // toute facon cote code sur topics[0], dans extractBurn().
  qs.set('topic0', BURN_TOPIC);
  // (c) Curseur INTÉGRAL : toute clé absente = page suivante mal bornée
  // = events silencieusement sautés.
  if (cursor && typeof cursor === 'object') {
    for (const [k, v] of Object.entries(cursor)) {
      if (v != null) qs.set(k, String(v));
    }
  }
  const url = `${EXPLORER_BASE}/api/v2/addresses/${CONTRACT_ADDRESS}/logs?${qs.toString()}`;
  const res = await withTimeout(fetch(url, { headers: BROWSER_HEADERS }), FETCH_TIMEOUT_MS);
  if (!res.ok) {
    // Le corps de la reponse est inclus dans l'erreur : un 403 anti-bot et
    // un 400 de parametre invalide se diagnostiquent en un coup d'oeil dans
    // les logs Vercel, au lieu de laisser un `scanPagesLues: 0` muet.
    const body = await res.text().catch(() => '');
    throw new Error(`explorer HTTP ${res.status} — ${body.slice(0, 160)}`);
  }
  return res.json();
}

// Scan INCRÉMENTAL : les logs arrivant du plus récent au plus ancien, on
// s'arrête dès qu'on repasse sous le high-water mark. En régime établi,
// une seule page suffit.
async function discoverIncremental(highWater, deadline) {
  const dirty = new Set();
  let cursor = null;
  let newHigh = highWater;
  let pages = 0;
  const stopAt = Math.max(0, highWater - REORG_MARGIN);

  for (let i = 0; i < PAGES_PER_INVOCATION; i++) {
    if (Date.now() > deadline) break;

    let json;
    try { json = await fetchLogsPage(cursor); }
    catch (e) { console.warn('leaderboard: page échouée (incrémental):', e.message); break; }
    pages++;

    const items = Array.isArray(json.items) ? json.items : [];
    let wentBelow = false;
    for (const it of items) {
      const b = extractBurn(it);
      if (!b) continue;
      if (b.block > newHigh) newHigh = b.block;
      if (b.block <= stopAt) { wentBelow = true; continue; }
      dirty.add(b.addr);
    }

    if (wentBelow) break;             // on a rejoint le déjà-traité
    cursor = json.next_page_params || null;
    if (!cursor) break;               // fin des events
  }

  return { dirty: [...dirty], newHigh, pages };
}

// Scan COMPLET, étalé sur plusieurs invocations via KEY_SCAN.
// Utilisé au bootstrap et sur ?full=1. Les totaux d'events collectés ici
// ne servent QUE de valeur d'attente : ils seront tous remplacés par les
// lectures on-chain. C'est ce qui évite d'afficher un tableau vide pendant
// la reconstruction initiale.
async function discoverFullStep(deadline) {
  const scan = (await redisGet(KEY_SCAN)) || { cursor: null, dirty: [], seed: {}, newHigh: 0, pages: 0 };
  const dirty = new Set(scan.dirty || []);
  const seed = scan.seed || {};
  let cursor = scan.cursor || null;
  let newHigh = scan.newHigh || 0;
  let complete = false;

  for (let i = 0; i < PAGES_PER_INVOCATION; i++) {
    if (Date.now() > deadline) break;

    let json;
    try { json = await fetchLogsPage(cursor); }
    catch (e) { console.warn('leaderboard: page échouée (full):', e.message); break; }
    scan.pages = (scan.pages || 0) + 1;

    const items = Array.isArray(json.items) ? json.items : [];
    for (const it of items) {
      const b = extractBurn(it);
      if (!b) continue;
      if (b.block > newHigh) newHigh = b.block;
      dirty.add(b.addr);
      try {
        seed[b.addr] = ((seed[b.addr] ? BigInt(seed[b.addr]) : 0n) + BigInt(b.amount)).toString();
      } catch {}
    }

    cursor = json.next_page_params || null;
    if (!cursor) { complete = true; break; }
  }

  if (complete) {
    await redisDel(KEY_SCAN);
    return { complete: true, dirty: [...dirty], seed, newHigh, pages: scan.pages };
  }
  await redisSet(KEY_SCAN, { cursor, dirty: [...dirty], seed, newHigh, pages: scan.pages });
  return { complete: false, dirty: [], seed: {}, newHigh, pages: scan.pages };
}

// ═══════════════════════════════════════════════════════════════════════
// Cycle
// ═══════════════════════════════════════════════════════════════════════

function emptyState() {
  return { amounts: {}, highWater: 0, queue: [], sweep: 0, bootstrapped: false, updatedAt: null };
}

async function advance(forceFull) {
  const started = Date.now();
  const state = (await redisGet(KEY_STATE)) || emptyState();
  if (forceFull) { state.bootstrapped = false; await redisDel(KEY_SCAN); }

  const discoveryDeadline = started + DISCOVERY_BUDGET_MS;
  let discovered = [];
  let note = '';

  // ── ÉTAGE 1 : découverte ──
  if (!state.bootstrapped) {
    const r = await discoverFullStep(discoveryDeadline);
    note = `bootstrap page ${r.pages}`;
    if (r.complete) {
      // Les totaux d'events servent de valeur d'attente pour les adresses
      // encore inconnues ; toutes passent en file pour lecture on-chain.
      for (const [a, v] of Object.entries(r.seed)) {
        if (state.amounts[a] == null) state.amounts[a] = v;
      }
      state.highWater = r.newHigh;
      state.bootstrapped = true;
      discovered = r.dirty;
      note = `bootstrap terminé (${r.pages} pages, ${r.dirty.length} adresses)`;
    }
  } else {
    const r = await discoverIncremental(state.highWater, discoveryDeadline);
    state.highWater = r.newHigh;
    discovered = r.dirty;
    note = `incrémental ${r.pages} page(s), ${r.dirty.length} adresse(s) touchée(s)`;
  }

  // ── File de rafraîchissement : nouveautés en TÊTE (priorité) ──
  const queue = Array.isArray(state.queue) ? state.queue : [];
  const qSet = new Set(queue);
  const fresh = discovered.filter(a => !qSet.has(a));
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

  // ── ÉTAGE 2 : lecture on-chain ──
  const refreshDeadline = started + INVOCATION_BUDGET_MS - SAVE_RESERVE_MS;
  const { amounts, done, failed } = await refreshAmounts(pending, refreshDeadline);

  Object.assign(state.amounts, amounts);
  const doneSet = new Set(done);
  state.queue = pending.filter(a => !doneSet.has(a) && !swept); // le balayage ne s'accumule pas
  state.updatedAt = new Date().toISOString();

  await redisSet(KEY_STATE, state);

  console.log(`leaderboard: ${note} | ${done.length} relues on-chain`
    + (swept ? ` (dont balayage ${swept})` : '')
    + ` | ${state.queue.length} en attente | ${failed} échecs`
    + ` | ${Object.keys(state.amounts).length} sacrifiants`
    + ` | ${Date.now() - started} ms`);

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

      // Test direct de l'explorateur DEPUIS LE SERVEUR (et non le navigateur,
      // ou tout fonctionne deja). C'est la difference entre les deux qui
      // revele une protection anti-bot.
      try {
        const testUrl = `${EXPLORER_BASE}/api/v2/addresses/${CONTRACT_ADDRESS}/logs?topic0=${BURN_TOPIC}`;
        const r = await withTimeout(fetch(testUrl, { headers: BROWSER_HEADERS }), FETCH_TIMEOUT_MS);
        out.explorateurStatut = r.status;
        const txt = await r.text();
        try {
          const j = JSON.parse(txt);
          out.explorateurItems = Array.isArray(j.items) ? j.items.length : 0;
          out.explorateurPageSuivante = !!j.next_page_params;
        } catch {
          out.explorateurReponseNonJson = txt.slice(0, 200);
        }
      } catch (e) { out.explorateurErreur = e.message; }
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
      const sc = await redisGet(KEY_SCAN);
      out.scanPagesLues = sc && sc.pages ? sc.pages : 0;
      out.scanAdressesTrouvees = sc && sc.dirty ? sc.dirty.length : 0;
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
      const scan = await redisGet(KEY_SCAN);
      const partialCount = scan && scan.dirty ? scan.dirty.length : 0;
      res.status(200).json({ leaderboard: [], totalBurners: 0, updatedAt: null, building: true, partialCount });
    }
  } catch (e) {
    console.error('leaderboard.js error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}
