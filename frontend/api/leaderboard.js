// /api/leaderboard — classement des sacrifiants.
//
// LE FRONT NE PARLE PLUS JAMAIS AU RPC. Il appelle cet endpoint, qui sert
// une liste déjà triée et calculée, mise en cache dans Redis.
//
// ══════════════════════════════════════════════════════════════════════
// v7 — LES MONTANTS NE VIENNENT PLUS DES EVENTS
// ══════════════════════════════════════════════════════════════════════
// Constat qui a motivé cette révision : un joueur affiché à 62.195 zkLTC
// avait en réalité 90.2954 zkLTC selon getBurnerInfo(). Vérifié à la main
// sur la chaîne. ~28 zkLTC d'events perdus par l'indexation, pour LUI
// seul — les autres lignes étaient justes. Signature typique d'une plage
// de pages sautée pendant un cycle, pas d'une erreur systématique.
//
// Trois défauts se cumulaient pour produire ça (tous corrigés ci-dessous),
// mais la leçon de fond est ailleurs : tant que les MONTANTS sont calculés
// en sommant des events, la moindre page perdue ou rejouée fausse un total
// de façon invisible et durable. Un scan d'events est fragile par nature :
// pagination, curseurs, timeouts, invocations concurrentes.
//
// NOUVELLE ARCHITECTURE — séparation stricte des deux rôles :
//
//   1. L'EXPLORATEUR sert UNIQUEMENT à découvrir QUI a brûlé au moins une
//      fois (la liste des adresses). Les montants sommés pendant le scan
//      ne servent plus que de filet de secours.
//
//   2. LES MONTANTS viennent de getBurnerInfo(address) lu sur la chaîne.
//      C'est le compteur interne du contrat : exact par construction,
//      insensible à toute la mécanique de pagination.
//
// Conséquence : une page d'events manquée ne coûte plus qu'un RETARD
// d'apparition d'une nouvelle adresse (rattrapée au cycle suivant). Elle
// ne peut plus produire un montant faux. C'est le point important.
//
// NOTE : getTopBurners() du contrat reste INUTILISABLE (tri on-chain O(n²)
// qui dépasse la limite de gas et revert). Ce sont les lectures INDIVIDUELLES
// getBurnerInfo() qui sont fiables et rapides — ne pas confondre les deux.
//
// ── Correctifs ponctuels également appliqués en v7 ────────────────────
//
// (a) VERROU QUI NE VERROUILLAIT PAS. `?NX=true&EX=55` n'est pas la syntaxe
//     Upstash : NX est un FLAG, pas une paire clé/valeur. Passé sous cette
//     forme il pouvait être ignoré → le SET réussissait toujours → tous les
//     appels concurrents obtenaient le "verrou". Le front appelant cet
//     endpoint toutes les 60 s PAR VISITEUR avec un cache-buster, plusieurs
//     advance() tournaient en parallèle, lisaient le même curseur, et
//     s'écrasaient mutuellement : selon l'ordre d'écriture, soit des pages
//     étaient rejouées (double comptage), soit sautées (montants perdus).
//     De plus `catch { return true; }` accordait le verrou dès que Redis
//     toussait. Désormais : `?NX&EX=55`, et en cas d'erreur on N'AVANCE PAS.
//     Mieux vaut un cycle plus lent qu'un cycle corrompu.
//
// (b) CURSEUR TRONQUÉ. Seules 3 clés de next_page_params étaient réinjectées
//     (block_number, index, items_count). Blockscout en ajoute d'autres selon
//     les versions (transaction_index, block_hash…). Une clé manquante = page
//     suivante mal bornée = events sautés. On renvoie l'objet TEL QUEL.
//
// (c) FILTRE topic0 NON GARANTI. Le contrat n'est pas vérifié sur
//     l'explorateur, donc it.decoded est TOUJOURS null et on passe toujours
//     par le décodage brut — sans aucun garde-fou. Or /api/v2/.../logs attend
//     historiquement `topic`, pas `topic0` : si le paramètre est ignoré, on
//     ingère TOUS les logs du contrat et on les interprète comme des burns.
//     On envoie les deux formes ET on refiltre côté client sur topics[0].
//
// (d) COMPARATEUR DE TRI INVALIDE. `(a,b) => (B > A ? 1 : -1)` ne renvoie
//     jamais 0 : en cas d'égalité il retourne -1, ce qui viole le contrat de
//     Array.prototype.sort et peut désordonner au-delà des seuls ex æquo.
//     Il y a de vrais ex æquo dans les données (plusieurs joueurs à 100.000).
//
// Stockage (Upstash Redis REST API via Vercel KV) :
//   leaderboard:<network>:progress -> { totals, cursor } cycle EN COURS,
//                                     jamais servi tel quel au front
//   leaderboard:<network>:final    -> { totals, updatedAt, ... } dernier
//                                     cycle COMPLET — SEULE source servie
//   leaderboard:<network>:lock     -> verrou anti-invocations concurrentes
//
// Au passage mainnet : changez EXPLORER_BASE / RPC_URL / CONTRACT_ADDRESS /
// NETWORK_TAG et tout repart proprement sur des clés fraîches.

// ─── CONFIG — à modifier au moment du passage au mainnet ───────────────
const EXPLORER_BASE = 'https://liteforge.explorer.caldera.xyz';
const RPC_URL = 'https://liteforge.rpc.caldera.xyz/http';
const CONTRACT_ADDRESS = '0x0AD3f776C45FF457d2d8e211A3174A4Db201b656';
const NETWORK_TAG = 'liteforge-testnet-v7';
// ─────────────────────────────────────────────────────────────────────

// keccak256("Burned(address,uint256,uint256,uint256,uint256)")
const BURN_TOPIC = '0xf1b8071d85a68dbc6b0a9b8ff17e44602315ec457cdf743f3eee37cf4a6dd38e';

// keccak256("getBurnerInfo(address)")[0:4] — sélecteur de la fonction.
// Codé en dur pour n'avoir AUCUNE dépendance (pas d'ethers côté serveur).
const SEL_BURNER_INFO = '0x39b7a75b';

const PAGES_PER_INVOCATION = 40;    // pages par appel (40×50 = 2000 events)
const FETCH_TIMEOUT_MS = 12000;     // par requête à l'explorateur
const RPC_TIMEOUT_MS = 8000;        // par requête au RPC
const RPC_BATCH_SIZE = 20;          // eth_call en parallèle par salve
const INVOCATION_BUDGET_MS = 42000; // marge sous maxDuration=60 (Vercel Pro)
const ENRICH_BUDGET_MS = 15000;     // part du budget réservée aux lectures RPC

const KEY_PROGRESS = `leaderboard:${NETWORK_TAG}:progress`;
const KEY_FINAL = `leaderboard:${NETWORK_TAG}:final`;
const KEY_LOCK = `leaderboard:${NETWORK_TAG}:lock`;

export const config = { maxDuration: 60 };

// ═══════════════════════════════════════════════════════════════════════
// Redis (Upstash REST)
// ═══════════════════════════════════════════════════════════════════════

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

function withTimeout(promise, ms, label = 'TIMEOUT') {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(label)), ms); }),
  ]);
}

async function redisGet(key) {
  try {
    const data = await redisCall(`/get/${encodeURIComponent(key)}`, { method: 'GET' });
    return data.result ? JSON.parse(data.result) : null;
  } catch { return null; }
}

// Les gros payloads passent en body, pas dans l'URL : un objet `totals` de
// plusieurs centaines d'adresses encodé en query string dépasse la limite
// de longueur d'URL et le SET échouait silencieusement (perte du cycle).
async function redisSet(key, value) {
  await redisCall(`/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    body: JSON.stringify(value),
  });
}

// (a) NX est un FLAG. Et en cas d'échec on refuse le verrou : ne pas
// avancer est toujours préférable à faire avancer deux cycles en parallèle.
async function tryAcquireLock() {
  try {
    const data = await redisCall(`/set/${encodeURIComponent(KEY_LOCK)}/1?NX&EX=55`, { method: 'POST' });
    return data.result === 'OK';
  } catch (e) {
    console.warn('leaderboard: acquisition du verrou impossible, on n\'avance pas:', e.message);
    return false;
  }
}

async function releaseLock() {
  try { await redisCall(`/del/${encodeURIComponent(KEY_LOCK)}`, { method: 'POST' }); } catch {}
}

// ═══════════════════════════════════════════════════════════════════════
// Lecture on-chain — source de vérité des montants
// ═══════════════════════════════════════════════════════════════════════

// getBurnerInfo(address) renvoie (uint256 amount, uint8 rank, string name).
// Seul `amount` nous intéresse : c'est le PREMIER mot de 32 octets du
// retour, donc décodable sans ABI ni librairie.
async function readBurnedOnChain(address) {
  const data = SEL_BURNER_INFO + address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const res = await withTimeout(fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: CONTRACT_ADDRESS, data }, 'latest'],
    }),
  }), RPC_TIMEOUT_MS, 'RPC_TIMEOUT');

  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  const raw = json.result;
  if (typeof raw !== 'string' || raw.length < 66) throw new Error('RPC: retour trop court');
  return BigInt('0x' + raw.slice(2, 66));
}

// Remplace les totaux issus des events par les valeurs exactes du contrat.
// Toute adresse dont la lecture échoue CONSERVE son total d'events : on
// dégrade, on ne perd jamais une ligne.
async function enrichWithOnChainTotals(eventTotals, deadline) {
  const addrs = Object.keys(eventTotals);
  const out = {};
  let exactCount = 0, fallbackCount = 0;

  for (let i = 0; i < addrs.length; i += RPC_BATCH_SIZE) {
    if (Date.now() > deadline) {
      // Budget épuisé : le reste garde ses totaux d'events pour ce cycle.
      for (let j = i; j < addrs.length; j++) {
        out[addrs[j]] = eventTotals[addrs[j]].toString();
        fallbackCount++;
      }
      console.warn(`leaderboard: budget RPC épuisé, ${fallbackCount} adresses sur totaux d'events`);
      break;
    }

    const batch = addrs.slice(i, i + RPC_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(ad => readBurnedOnChain(ad).catch(err => {
        console.warn(`leaderboard: getBurnerInfo(${ad}) a échoué:`, err.message);
        return null;
      }))
    );
    batch.forEach((ad, j) => {
      if (results[j] != null) { out[ad] = results[j].toString(); exactCount++; }
      else { out[ad] = eventTotals[ad].toString(); fallbackCount++; }
    });
  }

  return { totals: out, exactCount, fallbackCount };
}

// ═══════════════════════════════════════════════════════════════════════
// Construction du classement
// ═══════════════════════════════════════════════════════════════════════

function buildLeaderboard(totalsStr, updatedAt) {
  const sorted = Object.entries(totalsStr)
    .map(([address, amount]) => ({ address, amount: String(amount) }))
    // (d) Comparateur correct : renvoie 0 sur égalité. L'ancien renvoyait -1,
    // ce qui pouvait désordonner arbitrairement les joueurs ex æquo.
    .sort((a, b) => {
      const d = BigInt(b.amount) - BigInt(a.amount);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    })
    .slice(0, 100);
  return {
    leaderboard: sorted,
    totalBurners: Object.keys(totalsStr).length,
    updatedAt,
  };
}

// Fait avancer la construction d'un cycle. Reprend le curseur sauvegardé,
// traite jusqu'à PAGES_PER_INVOCATION pages, resauvegarde.
//
// Si la fin des events est atteinte, le cycle est COMPLET : les adresses
// découvertes sont enrichies avec leurs montants ON-CHAIN, le résultat
// remplace intégralement KEY_FINAL, et un cycle TOUT NEUF est amorcé.
// Jamais de mélange entre deux cycles (c'était le bug de la v5).
async function advance() {
  const started = Date.now();
  const progress = await redisGet(KEY_PROGRESS);

  const totals = {};
  if (progress && progress.totals) {
    for (const [a, v] of Object.entries(progress.totals)) totals[a] = BigInt(v);
  }
  let cursor = progress && progress.cursor ? progress.cursor : null;

  let reachedEnd = false;
  let scanned = 0, skippedTopic = 0;

  for (let i = 0; i < PAGES_PER_INVOCATION; i++) {
    // On réserve ENRICH_BUDGET_MS pour la phase de lecture on-chain.
    if (Date.now() - started > INVOCATION_BUDGET_MS - ENRICH_BUDGET_MS) break;

    const qs = new URLSearchParams();
    // (c) Les deux graphies : selon la version de Blockscout, l'endpoint
    // attend `topic` ou `topic0`. Le paramètre inconnu est ignoré sans
    // erreur, donc les envoyer tous les deux est sûr.
    qs.set('topic0', BURN_TOPIC);
    qs.set('topic', BURN_TOPIC);
    // (b) Curseur intégral : toute clé absente = page suivante mal bornée
    // = events silencieusement sautés.
    if (cursor && typeof cursor === 'object') {
      for (const [k, v] of Object.entries(cursor)) {
        if (v != null) qs.set(k, String(v));
      }
    }
    const url = `${EXPLORER_BASE}/api/v2/addresses/${CONTRACT_ADDRESS}/logs?${qs.toString()}`;

    let json;
    try {
      const res = await withTimeout(fetch(url, { headers: { Accept: 'application/json' } }), FETCH_TIMEOUT_MS);
      if (!res.ok) throw new Error(`explorer HTTP ${res.status}`);
      json = await res.json();
    } catch (err) {
      // On garde l'accumulation ; la prochaine invocation reprendra ce curseur.
      // Surtout : on NE marque PAS reachedEnd, donc un cycle interrompu ne
      // peut pas être publié comme s'il était complet.
      console.warn('leaderboard advance: page échouée:', err.message);
      break;
    }

    const items = Array.isArray(json.items) ? json.items : [];
    for (const it of items) {
      // (c) Garde-fou indispensable : le contrat n'étant pas vérifié,
      // it.decoded est toujours null et rien ne distingue un Burned d'un
      // autre event si le filtre serveur a été ignoré.
      if (!Array.isArray(it.topics) || !it.topics[0]
          || String(it.topics[0]).toLowerCase() !== BURN_TOPIC) {
        skippedTopic++;
        continue;
      }

      let addr = null, amount = null;

      // Chemin nominal si un jour le contrat est vérifié (décodage fourni).
      const params = it.decoded && Array.isArray(it.decoded.parameters) ? it.decoded.parameters : null;
      if (params) {
        const pUser = params.find(p => p.name === 'user') || params.find(p => p.indexed && p.type === 'address');
        const pAmt = params.find(p => p.name === 'amount') || params.find(p => !p.indexed && p.type === 'uint256');
        if (pUser) addr = String(pUser.value).toLowerCase();
        if (pAmt) amount = pAmt.value;
      }

      // Chemin brut (celui réellement emprunté aujourd'hui) : `user` est le
      // seul paramètre indexé -> topics[1] ; `amount` est le premier mot
      // non indexé -> 32 premiers octets du data.
      if ((!addr || amount == null) && it.topics[1]) {
        addr = ('0x' + String(it.topics[1]).slice(26)).toLowerCase();
        if (typeof it.data === 'string' && it.data.length >= 66) {
          amount = BigInt('0x' + it.data.slice(2, 66)).toString();
        }
      }

      if (!addr || amount == null) continue;
      try { totals[addr] = (totals[addr] || 0n) + BigInt(amount); scanned++; } catch {}
    }

    cursor = json.next_page_params || null;
    if (!cursor) { reachedEnd = true; break; }
  }

  if (!reachedEnd) {
    // Cycle incomplet : on sauvegarde la progression, jamais servie telle
    // quelle au front (elle est partielle par nature).
    const totalsStr = {};
    for (const [a, v] of Object.entries(totals)) totalsStr[a] = v.toString();
    await redisSet(KEY_PROGRESS, { totals: totalsStr, cursor });
    return { complete: false, scanned, skippedTopic };
  }

  // ── Cycle COMPLET : les adresses sont connues, on lit les vrais montants ──
  const enriched = await enrichWithOnChainTotals(totals, started + INVOCATION_BUDGET_MS);

  const updatedAt = new Date().toISOString();
  await redisSet(KEY_FINAL, {
    totals: enriched.totals,
    updatedAt,
    source: 'chain',
    exactCount: enriched.exactCount,
    fallbackCount: enriched.fallbackCount,
  });
  // Nouveau cycle vierge — ne JAMAIS repartir des totaux qu'on vient de
  // figer, sinon le prochain passage les rescanne et les double (bug v5).
  await redisSet(KEY_PROGRESS, { totals: {}, cursor: null });

  console.log(`leaderboard: cycle complet — ${Object.keys(enriched.totals).length} adresses, `
    + `${enriched.exactCount} exactes, ${enriched.fallbackCount} en repli, `
    + `${skippedTopic} logs hors-sujet ignorés`);

  return { complete: true, scanned, skippedTopic, ...enriched };
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
    // Un seul advance() à la fois, réellement garanti cette fois (a).
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
    // Jamais la progression d'un cycle en cours : partielle par nature,
    // elle donnerait des totaux sous-évalués pendant la reconstruction.
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
