// api/_session.js — session de connexion signée (« Sign in with Ethereum »).
//
// Le fichier commence par « _ » : Vercel ne l'expose PAS comme route, c'est
// un module partagé importé par auth.js, username.js, avatar.js et skin.js.
//
// PRINCIPE
//   1. Le joueur signe UNE fois un message de connexion lisible (gratuit,
//      aucune transaction).
//   2. /api/auth vérifie la signature et pose un cookie de session :
//      HttpOnly (illisible par le JavaScript de la page), Secure, SameSite=Lax
//      (non envoyé par les requêtes POST venant d'autres sites), 30 jours.
//   3. Les routes du profil lisent ce cookie au lieu d'exiger une signature
//      à chaque modification.
//
// SANS COOKIES : si le navigateur refuse le cookie, /api/auth renvoie aussi le
// jeton dans sa réponse. Le site le garde en mémoire et l'envoie dans l'en-tête
// Authorization. Le joueur reste alors connecté tant que la page est ouverte
// (il resignera au prochain chargement), au lieu d'être bloqué.
//
// Le cookie contient l'adresse et la date d'expiration, scellées par un HMAC.
// Rien n'est stocké côté serveur : aucune commande Redis, aucun coût.
//
// SECRET : définir SESSION_SECRET dans les variables d'environnement Vercel
// (une longue chaîne aléatoire). À défaut, une clé est dérivée du jeton
// Upstash, déjà secret ; changer ce jeton déconnecterait alors tout le monde.

import crypto from 'node:crypto';

export const SESSION_COOKIE = 'sv_session';
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;   // 30 jours
export const SIGNIN_MAX_AGE_MS = 10 * 60 * 1000;      // signature valable 10 min

function secretKey() {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  const fallback = process.env.KV_REST_API_TOKEN;
  if (!fallback) throw new Error('SESSION_SECRET is not configured');
  return crypto.createHash('sha256').update('sv-session:' + fallback).digest('hex');
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/// Message à signer. Doit être reconstruit À L'IDENTIQUE par le site
/// (svSigninMessage dans index.html).
export function signinMessage(address, host, issuedAt) {
  return 'The Silver Void wants you to sign in with your wallet:\n'
    + address.toLowerCase() + '\n\n'
    + 'This signature is free. It sends no transaction and grants no spending rights.\n\n'
    + 'Site: ' + host + '\n'
    + 'Issued At: ' + issuedAt;
}

export function createToken(address) {
  const payload = b64u(JSON.stringify({ a: address.toLowerCase(), e: Date.now() + SESSION_MAX_AGE_S * 1000 }));
  const mac = b64u(crypto.createHmac('sha256', secretKey()).update(payload).digest());
  return payload + '.' + mac;
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/// Adresse (minuscules) de la session valide, ou null.
export function sessionAddress(req) {
  try {
    let token = readCookie(req, SESSION_COOKIE);
    if (!token) {
      const auth = String(req.headers.authorization || '');
      if (auth.startsWith('Bearer ')) token = auth.slice(7).trim();
    }
    if (!token) return null;
    const [payload, mac] = token.split('.');
    if (!payload || !mac) return null;
    const expected = b64u(crypto.createHmac('sha256', secretKey()).update(payload).digest());
    const a = Buffer.from(mac), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.a || !data.e || Date.now() > data.e) return null;
    return data.a;
  } catch {
    return null;
  }
}

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}
