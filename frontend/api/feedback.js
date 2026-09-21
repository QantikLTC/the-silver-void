// /api/feedback — copie de sauvegarde de chaque message du formulaire.
//
// POURQUOI : Web3Forms (offre gratuite) classe parfois de vrais messages en
// spam, sans e-mail et en répondant quand même « succès » au site. Le filtre
// avancé ne peut pas être désactivé sans l'offre Pro. Chaque message est
// donc AUSSI enregistré ici, dans Upstash : plus aucun retour ne se perd.
//
//   POST /api/feedback            → enregistre un message (appelé par le site)
//   GET  /api/feedback?key=XXX    → liste les 100 derniers (page lisible)
//        &format=json             → la même liste en JSON
//
// La lecture est protégée par DEBUG_KEY (variable d'environnement Vercel,
// déjà utilisée par /api/leaderboard?debug=1).
//
// Coût : 4 commandes Redis par message envoyé (limite de débit + ajout +
// taille de la liste), soit quelques centaines par mois au plus.

const KEY_LIST = 'feedback:list';
const MAX_KEPT = 500;                 // les plus anciens au-delà sont supprimés
const RATE_MAX = 5;                   // messages par heure et par adresse IP
const RATE_WINDOW_S = 3600;

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

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    // ── Enregistrer un message ─────────────────────────────────────────
    if (req.method === 'POST') {
      const b = req.body || {};
      const message = clip(b.message, 4000).trim();
      if (!message) { res.status(400).json({ error: 'Empty message' }); return; }

      // Limite par adresse IP : un robot ne peut pas remplir la base.
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const rateKey = `feedback:rate:${ip}`;
      const n = await redisCmd(['INCR', rateKey]);
      if (n === 1) await redisCmd(['EXPIRE', rateKey, String(RATE_WINDOW_S)]);
      if (n > RATE_MAX) { res.status(429).json({ error: 'Too many messages' }); return; }

      const entry = {
        t: new Date().toISOString(),
        category: clip(b.category, 40),
        chronicle: clip(b.chronicle, 120),
        satisfaction: clip(b.satisfaction, 20),
        email: clip(b.email, 200),
        wallet: clip(b.wallet, 60),
        page: clip(b.page, 300),
        device: clip(b.device, 300),
        message,
      };
      await redisCmd(['LPUSH', KEY_LIST, JSON.stringify(entry)]);
      await redisCmd(['LTRIM', KEY_LIST, '0', String(MAX_KEPT - 1)]);
      res.status(200).json({ ok: true });
      return;
    }

    // ── Lire les messages (réservé à toi) ──────────────────────────────
    if (req.method === 'GET') {
      if (!process.env.DEBUG_KEY || req.query.key !== process.env.DEBUG_KEY) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const raw = await redisCmd(['LRANGE', KEY_LIST, '0', '99']) || [];
      const items = raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);

      if (req.query.format === 'json') { res.status(200).json({ count: items.length, items }); return; }

      const rows = items.map(e => `
        <tr>
          <td>${esc(e.t.replace('T', ' ').slice(0, 16))}</td>
          <td>${esc(e.category)}${e.chronicle ? '<br><small>' + esc(e.chronicle) + '</small>' : ''}</td>
          <td class="m">${esc(e.message)}</td>
          <td>${esc(e.satisfaction)}</td>
          <td><small>${esc(e.email || '')}<br>${esc(e.wallet || '')}</small></td>
          <td><small>${esc(e.page)}</small></td>
        </tr>`).join('');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Silver Void — feedback</title>
        <style>
          body{font-family:system-ui,sans-serif;background:#0b1024;color:#e6e9f0;margin:0;padding:1.5rem}
          h1{font-size:1.1rem;font-weight:600;margin:0 0 1rem}
          table{border-collapse:collapse;width:100%;font-size:0.85rem}
          th,td{border-bottom:1px solid #232a45;padding:0.55rem;vertical-align:top;text-align:left}
          th{color:#8b93ad;font-weight:500}
          td.m{white-space:pre-wrap;max-width:46ch}
          small{color:#8b93ad}
          .wrap{overflow-x:auto}
        </style>
        <h1>Feedback — ${items.length} derniers messages</h1>
        <div class="wrap"><table>
          <tr><th>Date (UTC)</th><th>Type</th><th>Message</th><th>Note</th><th>Contact</th><th>Page</th></tr>
          ${rows || '<tr><td colspan="6">Aucun message pour l’instant.</td></tr>'}
        </table></div>`);
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('feedback.js error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}
