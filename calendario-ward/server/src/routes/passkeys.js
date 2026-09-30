// ----------------------------------------------------------------------
// ENTRAR CON HUELLA O ROSTRO (passkeys / WebAuthn) — sin librerías externas
// ----------------------------------------------------------------------
// La persona, ya con sesión iniciada, activa "Entrar con huella o rostro"
// en ese celular/computador: el dispositivo crea una llave propia (la
// huella o el rostro NUNCA salen del teléfono; al servidor solo llega una
// llave pública). La próxima vez, en la pantalla de ingreso toca "Entrar
// con huella o rostro" y el dispositivo firma un desafío con esa llave.
//
// Se verifica con node:crypto (ES256 y RS256), con un lector CBOR mínimo.
// Atestación "none": no se valida la marca del dispositivo, solo la firma.
//
//   POST /api/auth/passkey/registro/opciones   (con sesión)
//   POST /api/auth/passkey/registro            (con sesión)
//   POST /api/auth/passkey/login/opciones
//   POST /api/auth/passkey/login
//   DELETE /api/auth/passkey                   (con sesión: borra las suyas)
// ----------------------------------------------------------------------
import crypto from 'crypto';
import { sendJson } from '../router.js';
import { requireAuth } from '../guard.js';
import { load, withDb } from '../db.js';
import { createSession, publicUser } from '../auth.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const desdeB64u = (s) => Buffer.from(String(s || ''), 'base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// Desafíos de un solo uso (5 minutos).
const desafios = new Map();
function nuevoDesafio(extra) {
  const c = b64u(crypto.randomBytes(32));
  desafios.set(c, { ...extra, vence: Date.now() + 5 * 60_000 });
  for (const [k, v] of desafios) if (v.vence < Date.now()) desafios.delete(k);
  return c;
}
function usarDesafio(c) {
  const d = desafios.get(c);
  desafios.delete(c);
  return d && d.vence > Date.now() ? d : null;
}

// Dominio y origen de la app (detrás del proxy de Render).
function sitio(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const rpId = host.replace(/:\d+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || (rpId === 'localhost' ? 'http' : 'https')).split(',')[0].trim();
  return { rpId, origen: `${proto}://${host}` };
}

// ---- CBOR mínimo (lo que usan las llaves WebAuthn) ----
function cbor(buf, pos = 0) {
  const ini = buf[pos]; const tipo = ini >> 5; let info = ini & 31; pos += 1;
  let largo = info;
  if (info === 24) { largo = buf[pos]; pos += 1; }
  else if (info === 25) { largo = buf.readUInt16BE(pos); pos += 2; }
  else if (info === 26) { largo = buf.readUInt32BE(pos); pos += 4; }
  else if (info === 27) { largo = Number(buf.readBigUInt64BE(pos)); pos += 8; }
  if (tipo === 0) return [largo, pos];
  if (tipo === 1) return [-1 - largo, pos];
  if (tipo === 2) return [buf.subarray(pos, pos + largo), pos + largo];
  if (tipo === 3) return [buf.subarray(pos, pos + largo).toString('utf8'), pos + largo];
  if (tipo === 4) { const a = []; for (let i = 0; i < largo; i += 1) { let v; [v, pos] = cbor(buf, pos); a.push(v); } return [a, pos]; }
  if (tipo === 5) { const m = new Map(); for (let i = 0; i < largo; i += 1) { let k; let v; [k, pos] = cbor(buf, pos); [v, pos] = cbor(buf, pos); m.set(k, v); } return [m, pos]; }
  if (tipo === 7) return [info === 21 ? true : info === 20 ? false : null, pos];
  throw new Error('CBOR no soportado');
}

function leerAuthData(ad) {
  const rpIdHash = ad.subarray(0, 32);
  const flags = ad[32];
  const contador = ad.readUInt32BE(33);
  const out = { rpIdHash, flags, contador, up: !!(flags & 1), uv: !!(flags & 4) };
  if (flags & 64) {
    const lenId = ad.readUInt16BE(53);
    out.credId = ad.subarray(55, 55 + lenId);
    [out.cose] = cbor(ad, 55 + lenId);
  }
  return out;
}
// Llave COSE → JWK (ES256 o RS256).
function coseAJwk(cose) {
  const kty = cose.get(1); const alg = cose.get(3);
  if (kty === 2 && alg === -7) return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)) } };
  if (kty === 3 && alg === -257) return { alg: -257, jwk: { kty: 'RSA', n: b64u(cose.get(-1)), e: b64u(cose.get(-2)) } };
  throw new Error('Tipo de llave no soportado');
}
function revisarCliente(clientDataB64, tipo, desafioEsperado, origen) {
  const raw = desdeB64u(clientDataB64);
  const c = JSON.parse(raw.toString('utf8'));
  if (c.type !== tipo) throw new Error('Tipo inválido');
  if (c.challenge !== desafioEsperado) throw new Error('Desafío inválido');
  if (c.origin !== origen) throw new Error(`Origen inválido (${c.origin})`);
  return raw;
}

export function registerPasskeyRoutes(router) {
  router.post('/api/auth/passkey/registro/opciones', requireAuth(async (req, res) => {
    const { rpId } = sitio(req);
    const u = req.user;
    const challenge = nuevoDesafio({ tipo: 'registro', userId: u.id });
    sendJson(res, 200, {
      challenge,
      rp: { name: 'OrganizaSion', id: rpId },
      user: { id: b64u(Buffer.from(`u${u.id}`)), name: u.email || `usuario${u.id}`, displayName: u.name || u.email || 'Usuario' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
      attestation: 'none',
      timeout: 60_000,
      excludeCredentials: (u.passkeys || []).map((p) => ({ type: 'public-key', id: p.id })),
    });
  }));

  router.post('/api/auth/passkey/registro', requireAuth(async (req, res, params, body) => {
    try {
      const d = usarDesafio(body?.challenge);
      if (!d || d.tipo !== 'registro' || d.userId !== req.user.id) throw new Error('El pedido venció, inténtalo de nuevo');
      const { rpId, origen } = sitio(req);
      revisarCliente(body?.clientDataJSON, 'webauthn.create', body.challenge, origen);
      const [att] = cbor(desdeB64u(body?.attestationObject));
      const ad = leerAuthData(att.get('authData'));
      if (!ad.rpIdHash.equals(sha256(Buffer.from(rpId)))) throw new Error('Dominio inválido');
      if (!ad.up || !ad.uv || !ad.credId || !ad.cose) throw new Error('El dispositivo no verificó la huella o el rostro');
      const llave = coseAJwk(ad.cose);
      const nombre = String(body?.dispositivo || '').slice(0, 60) || 'Dispositivo';
      await withDb((db) => {
        const u = db.users.find((x) => x.id === req.user.id);
        u.passkeys = (u.passkeys || []).filter((p) => p.id !== b64u(ad.credId));
        u.passkeys.push({ id: b64u(ad.credId), jwk: llave.jwk, alg: llave.alg, contador: ad.contador, dispositivo: nombre, creadoEn: new Date().toISOString() });
        u.passkeys = u.passkeys.slice(-10);
      });
      sendJson(res, 200, { ok: true });
    } catch (e) {
      console.warn('[passkey] registro:', e.message);
      sendJson(res, 400, { error: 'No se pudo activar la entrada con huella o rostro en este dispositivo.' });
    }
  }));

  router.post('/api/auth/passkey/login/opciones', async (req, res) => {
    const { rpId } = sitio(req);
    sendJson(res, 200, { challenge: nuevoDesafio({ tipo: 'login' }), rpId, userVerification: 'required', timeout: 60_000, allowCredentials: [] });
  });

  router.post('/api/auth/passkey/login', async (req, res, params, body) => {
    try {
      const d = usarDesafio(body?.challenge);
      if (!d || d.tipo !== 'login') throw new Error('El pedido venció, inténtalo de nuevo');
      const { rpId, origen } = sitio(req);
      const clientRaw = revisarCliente(body?.clientDataJSON, 'webauthn.get', body.challenge, origen);
      const data = load();
      const user = data.users.find((u) => (u.passkeys || []).some((p) => p.id === body?.id));
      const pk = user && user.passkeys.find((p) => p.id === body.id);
      if (!pk) return sendJson(res, 401, { error: 'Este dispositivo ya no está registrado. Entra con tu contraseña y vuelve a activarlo.' });
      const authData = desdeB64u(body?.authenticatorData);
      const ad = leerAuthData(authData);
      if (!ad.rpIdHash.equals(sha256(Buffer.from(rpId)))) throw new Error('Dominio inválido');
      if (!ad.up || !ad.uv) throw new Error('Sin verificación de usuario');
      const llave = crypto.createPublicKey({ key: pk.jwk, format: 'jwk' });
      const firmado = Buffer.concat([authData, sha256(clientRaw)]);
      const ok = crypto.verify('sha256', firmado, llave, desdeB64u(body?.signature));
      if (!ok) throw new Error('Firma inválida');
      if (ad.contador && pk.contador && ad.contador <= pk.contador) throw new Error('Contador inválido');
      await withDb((db) => {
        const u = db.users.find((x) => x.id === user.id);
        const p = (u.passkeys || []).find((x) => x.id === pk.id);
        if (p) { p.contador = ad.contador; p.usadoEn = new Date().toISOString(); }
      });
      const token = await createSession(user.id);
      const org = user.organizationId ? data.organizations.find((o) => o.id === user.organizationId) : null;
      sendJson(res, 200, { token, user: { ...publicUser(user), organization: org || null } });
    } catch (e) {
      console.warn('[passkey] login:', e.message);
      sendJson(res, 401, { error: 'No se pudo entrar con huella o rostro. Prueba de nuevo o usa tu contraseña.' });
    }
  });

  router.delete('/api/auth/passkey', requireAuth(async (req, res) => {
    await withDb((db) => { const u = db.users.find((x) => x.id === req.user.id); if (u) u.passkeys = []; });
    sendJson(res, 200, { ok: true });
  }));
}
