// /api/auth — connexion par signature du wallet.
//
//   GET    /api/auth  -> { address }  adresse de la session en cours, ou null
//   POST   /api/auth  { address, issuedAt, signature } -> pose le cookie de session
//   DELETE /api/auth  -> ferme la session
//
// Aucune commande Redis : la session est un cookie scellé (voir _session.js).

import { verifyMessage } from 'ethers';
import {
  signinMessage, createToken, sessionAddress,
  setSessionCookie, clearSessionCookie, SIGNIN_MAX_AGE_MS,
} from './_session.js';

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Même origine uniquement : pas d'en-têtes CORS, un autre site ne peut ni
  // lire la réponse ni ouvrir de session.
  try {
    if (req.method === 'GET') {
      res.status(200).json({ address: sessionAddress(req) });
      return;
    }

    if (req.method === 'DELETE') {
      clearSessionCookie(res);
      res.status(200).json({ ok: true });
      return;
    }

    if (req.method === 'POST') {
      const { address, issuedAt, signature } = req.body || {};
      if (!ADDRESS_REGEX.test(String(address || '')) || !issuedAt || !signature) {
        res.status(400).json({ error: 'Missing address, issuedAt, or signature' });
        return;
      }

      const t = Date.parse(issuedAt);
      if (!Number.isFinite(t) || Math.abs(Date.now() - t) > SIGNIN_MAX_AGE_MS) {
        res.status(401).json({ error: 'Sign-in request expired, please try again' });
        return;
      }

      const message = signinMessage(String(address), String(req.headers.host || ''), String(issuedAt));
      let signer;
      try {
        signer = verifyMessage(message, signature);
      } catch {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
      if (signer.toLowerCase() !== String(address).toLowerCase()) {
        res.status(401).json({ error: 'Signature does not match wallet' });
        return;
      }

      const token = createToken(signer);
      setSessionCookie(res, token);
      // Jeton aussi dans la réponse : secours pour les navigateurs qui bloquent les cookies.
      res.status(200).json({ ok: true, address: signer.toLowerCase(), token });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('auth.js error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}
