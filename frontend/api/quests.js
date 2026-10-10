// /api/quests — quêtes hebdomadaires, VERSION SITE EN LIGNE (aperçu sans récompense).
//
// PRINCIPE
//   Chaque semaine (du lundi 00:00 UTC au dimanche), trois quêtes, les mêmes
//   pour tous, portant uniquement sur des actions vérifiables sur la chaîne.
//   Sur le site en ligne, c'est un TEST : aucune récompense n'est délivrée.
//   Le tirage bonus arrivera avec les contrats du mainnet (voir la version de
//   la branche mainnet-contracts, qui signe les bons).
//
// PROGRESSION
//   Les contrats actuels tiennent des compteurs cumulés par joueur. À la
//   première visite de la semaine, le serveur photographie ces compteurs (le
//   « point de départ ») ; la progression est la différence avec leur valeur
//   actuelle. Une action faite avant cette première visite ne compte pas.
//
//   Différences avec la version mainnet, imposées par les anciens contrats :
//   - Reliques : seulement « tirer une relique » (pas de compteur de forges
//     par joueur dans l'ancien contrat).
//   - Burn : seules les offrandes créditées au Ritual comptent (dans les
//     anciens contrats, duels et forge brûlent sans passer par le Ritual).
//
// ANTI-ABUS
//   Le point de départ n'est enregistré que pour un wallet classé (rang ≥ 1) :
//   un robot qui inventerait des adresses ne remplit pas la base.
//
// VARIABLES D'ENVIRONNEMENT
//   KV_REST_API_URL / KV_REST_API_TOKEN   base Upstash (déjà en place).

import { JsonRpcProvider, Contract, formatEther } from 'ethers';

const RPC_URL = 'https://liteforge.rpc.caldera.xyz/http';
const CHAIN_ID = 4441;
const CONTRACTS = {
  ritual: '0x0AD3f776C45FF457d2d8e211A3174A4Db201b656',
  duels:  '0xEA3ac301Fef474c8799924EC58c48f2c4114684B',
  relics: '0xAe23A9c55aA48Dd59E88E5080F15175067a71801',
};
const KEY_PREFIX = 'quest';          // la version test utilise 'v2:quest' : aucun mélange
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/// Semaine en cours, même calcul que le futur contrat : (timestamp + 3 jours) / 7 jours.
function weekOf(ts) { return Math.floor((ts + 3 * 86400) / (7 * 86400)); }
function weekBounds(week) {
  const start = week * 7 * 86400 - 3 * 86400;
  return { start, end: start + 7 * 86400 };
}

function questsFor(week) {
  const duels = [3, 5, 4][week % 3];
  const draws = [1, 2][week % 2];
  const burn  = ['0.05', '0.1', '0.08'][week % 3];
  return [
    { id: 'duels', metric: 'duels', goal: duels, title: `Decide ${duels} duels`, desc: 'Win, lose or forfeit: every decided duel counts. Ties do not.' },
    { id: 'draws', metric: 'draws', goal: draws, title: draws > 1 ? `Draw ${draws} relics` : 'Draw a relic', desc: 'Seal and reveal your draws in the Arena.' },
    { id: 'burn',  metric: 'burned', goal: Number(burn), title: `Offer ${burn} zkLTC`, desc: 'Offerings made at the Ritual.' },
  ];
}

// ── Redis (Upstash REST) ─────────────────────────────────────────────────
async function redis(cmd) {
  const res = await fetch(process.env.KV_REST_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.error)) throw new Error(`Redis ${cmd[0]} failed`);
  return json ? json.result : null;
}

// ── Lecture de la chaîne ────────────────────────────────────────────────
const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const ritual = new Contract(CONTRACTS.ritual, [
  'function getBurnerInfo(address) view returns (uint256 amount, uint8 rank, string rankName)',
], provider);
const duels = new Contract(CONTRACTS.duels, ['function duelCountOf(address) view returns (uint256)'], provider);
const relics = new Contract(CONTRACTS.relics, [
  'function drawsUsed(address) view returns (uint256)',
  'function duelsOf(address) view returns (uint256)',
], provider);

/// Duels décidés : compteur du contrat de duel, sinon celui des reliques
/// (celui qui sert à gagner les tirages).
async function duelCount(wallet) {
  try { return Number(await duels.duelCountOf(wallet)); }
  catch (_) { return Number(await relics.duelsOf(wallet)); }
}

async function readCounters(wallet) {
  const [d, draws, info] = await Promise.all([
    duelCount(wallet), relics.drawsUsed(wallet), ritual.getBurnerInfo(wallet),
  ]);
  return { duels: d, draws: Number(draws), burned: info.amount.toString(), rank: Number(info.rank) };
}

function progressOf(quest, base, now) {
  if (quest.metric === 'burned') {
    const done = BigInt(now.burned) - BigInt(base.burned);
    return done > 0n ? Number(formatEther(done)) : 0;
  }
  return Math.max(0, now[quest.metric] - base[quest.metric]);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const wallet = String(req.query?.wallet || '');
  if (!ADDR_RE.test(wallet)) { res.status(400).json({ error: 'Invalid wallet' }); return; }

  try {
    const week = weekOf(Math.floor(Date.now() / 1000));
    const quests = questsFor(week);
    const now = await readCounters(wallet);
    const ranked = now.rank >= 1;

    let base = now;   // non classé : progression à zéro, rien d'enregistré
    if (ranked) {
      const baseKey = `${KEY_PREFIX}:${week}:${wallet.toLowerCase()}`;
      const raw = await redis(['GET', baseKey]);
      if (raw) base = JSON.parse(raw);
      else {
        await redis(['SET', baseKey, JSON.stringify(now), 'NX', 'EX', String(15 * 86400)]);
        base = JSON.parse(await redis(['GET', baseKey]));
      }
    }

    const list = quests.map(q => {
      const progress = progressOf(q, base, now);
      return { ...q, progress: Math.min(progress, q.goal), done: progress >= q.goal };
    });
    res.status(200).json({
      week, ...weekBounds(week), ranked, quests: list,
      allDone: list.every(q => q.done), preview: true,   // aperçu : pas de récompense
    });
  } catch (e) {
    console.error('quests.js:', e.message);
    res.status(503).json({ error: 'The chain did not answer. Try again in a moment.' });
  }
}
