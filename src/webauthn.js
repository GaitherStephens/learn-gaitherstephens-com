// webauthn.js — passkeys for learn.gaitherstephens.com.
// Single-user port of the proven recipes/gaithernews implementation
// (hand-rolled, SubtleCrypto only, no dependencies).
//
//  - Login is discoverable (resident key): the browser tells us which
//    credential was used and we look it up. There is only one account.
//  - We rely on the browser's response.getPublicKey() (SPKI/DER), skipping
//    CBOR/COSE on the server. Possession is proven by the assertion step.
//  - Challenges are stateless HMAC-signed cookies (5 min). The HMAC secret
//    self-bootstraps into the settings table.
//  - Requires the UV flag (biometric / device PIN).

export const RP_ID = "learn.gaitherstephens.com";
export const RP_NAME = "FTCE Science 5-9 Study";
export const ORIGIN = "https://learn.gaitherstephens.com";
export const CHALLENGE_COOKIE = "learn_chal";
const CHALLENGE_TTL_SEC = 60 * 5;
const SECRET_KEY = "webauthn_chal_secret";

/* ── base64 / base64url ─────────────────────────────────────────────────── */

export function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8(s) { return new TextEncoder().encode(s); }

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

// public_key is stored as standard base64 (from getPublicKey()); normalize.
function toB64url(b64) {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ── challenge-signing secret (self-bootstraps into settings) ───────────── */

let cachedSecret = null;

async function getSecret(d1) {
  if (cachedSecret) return cachedSecret;
  const row = await d1.prepare("SELECT value FROM settings WHERE key = ?").bind(SECRET_KEY).first();
  if (row?.value) {
    cachedSecret = b64urlToBytes(row.value);
    return cachedSecret;
  }
  const fresh = crypto.getRandomValues(new Uint8Array(32));
  // INSERT OR IGNORE so an isolate race cannot error; re-read after.
  await d1.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
    .bind(SECRET_KEY, bytesToB64url(fresh)).run();
  const confirm = await d1.prepare("SELECT value FROM settings WHERE key = ?").bind(SECRET_KEY).first();
  cachedSecret = b64urlToBytes(confirm.value);
  return cachedSecret;
}

/* ── HMAC-signed challenge tokens ───────────────────────────────────────── */

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signToken(d1, payload) {
  const key = await hmacKey(await getSecret(d1));
  const body = bytesToB64url(utf8(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(body)));
  return body + "." + bytesToB64url(sig);
}

async function verifyToken(d1, token) {
  if (!token || token.indexOf(".") < 0) return null;
  const [body, sig] = token.split(".", 2);
  const key = await hmacKey(await getSecret(d1));
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(body)));
  if (!timingSafeEqual(expected, b64urlToBytes(sig))) return null;
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))); }
  catch { return null; }
  if (typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) return null;
  return payload;
}

/* ── challenges (cookie in / cookie out) ────────────────────────────────── */

export function readCookie(req, name) {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

export function challengeCookie(value, maxAgeSec) {
  return `${CHALLENGE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export async function issueChallenge(d1, kind) {
  const challenge = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  const token = await signToken(d1, {
    c: challenge, k: kind,
    exp: Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SEC,
  });
  return { challenge, setCookie: challengeCookie(token, CHALLENGE_TTL_SEC) };
}

async function consumeChallenge(d1, req, kind) {
  const payload = await verifyToken(d1, readCookie(req, CHALLENGE_COOKIE));
  if (!payload || payload.k !== kind || typeof payload.c !== "string") return null;
  return payload.c;
}

export function clearChallengeCookie() { return challengeCookie("", 0); }

/* ── ECDSA DER -> raw (r||s) for SubtleCrypto verify ────────────────────── */

function derToRawEcdsa(der) {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error("bad DER: no SEQUENCE");
  if (der[i] & 0x80) i += 1 + (der[i] & 0x7f);
  else i += 1;
  if (der[i++] !== 0x02) throw new Error("bad DER: no INTEGER r");
  const rLen = der[i++];
  const r = der.slice(i, i + rLen);
  i += rLen;
  if (der[i++] !== 0x02) throw new Error("bad DER: no INTEGER s");
  const sLen = der[i++];
  const s = der.slice(i, i + sLen);
  const fix = (b) => {
    let v = b;
    while (v.length > 32 && v[0] === 0x00) v = v.slice(1);
    if (v.length < 32) {
      const out = new Uint8Array(32);
      out.set(v, 32 - v.length);
      return out;
    }
    return v.slice(v.length - 32);
  };
  const out = new Uint8Array(64);
  out.set(fix(r), 0);
  out.set(fix(s), 32);
  return out;
}

/* ── registration ───────────────────────────────────────────────────────── */

export async function verifyRegistration(d1, req, body) {
  const expected = await consumeChallenge(d1, req, "register");
  if (!expected) return { ok: false, reason: "challenge expired or missing" };
  let cd;
  try { cd = JSON.parse(new TextDecoder().decode(b64urlToBytes(body.clientDataJSON))); }
  catch { return { ok: false, reason: "bad clientDataJSON" }; }
  if (cd.type !== "webauthn.create") return { ok: false, reason: "wrong type" };
  if (cd.challenge !== expected) return { ok: false, reason: "challenge mismatch" };
  if (cd.origin !== ORIGIN) return { ok: false, reason: "origin mismatch" };
  if (body.alg !== -7 && body.alg !== -257) return { ok: false, reason: "unsupported alg" };
  return { ok: true };
}

/* ── authentication (assertion) ─────────────────────────────────────────── */

export async function verifyAssertion(d1, req, body, cred) {
  const expected = await consumeChallenge(d1, req, "login");
  if (!expected) return { ok: false, reason: "challenge expired or missing" };

  const clientDataBytes = b64urlToBytes(body.clientDataJSON);
  let cd;
  try { cd = JSON.parse(new TextDecoder().decode(clientDataBytes)); }
  catch { return { ok: false, reason: "bad clientDataJSON" }; }
  if (cd.type !== "webauthn.get") return { ok: false, reason: "wrong type" };
  if (cd.challenge !== expected) return { ok: false, reason: "challenge mismatch" };
  if (cd.origin !== ORIGIN) return { ok: false, reason: "origin mismatch" };

  const authData = b64urlToBytes(body.authenticatorData);
  if (authData.length < 37) return { ok: false, reason: "authData too short" };
  const rpIdHash = authData.slice(0, 32);
  const expectedRpIdHash = await sha256(utf8(RP_ID));
  if (!timingSafeEqual(rpIdHash, expectedRpIdHash)) return { ok: false, reason: "rpId mismatch" };
  const flags = authData[32];
  if ((flags & 0x01) === 0) return { ok: false, reason: "user not present" };
  if ((flags & 0x04) === 0) return { ok: false, reason: "user not verified" };

  const clientHash = await sha256(clientDataBytes);
  const signed = new Uint8Array(authData.length + clientHash.length);
  signed.set(authData, 0);
  signed.set(clientHash, authData.length);

  const spki = b64urlToBytes(toB64url(cred.public_key));
  const sigBytes = b64urlToBytes(body.signature);

  try {
    if (cred.alg === -7) {
      const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const raw = derToRawEcdsa(sigBytes);
      const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw, signed);
      return ok ? { ok: true } : { ok: false, reason: "bad signature" };
    } else if (cred.alg === -257) {
      const key = await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sigBytes, signed);
      return ok ? { ok: true } : { ok: false, reason: "bad signature" };
    }
    return { ok: false, reason: "unsupported alg" };
  } catch (e) {
    return { ok: false, reason: "verify error: " + String(e?.message || e) };
  }
}

/* ── D1 helpers (single user) ───────────────────────────────────────────── */

export async function listCredentials(d1) {
  const rows = await d1.prepare(
    "SELECT id, label, created_at, last_used_at FROM webauthn_credentials ORDER BY created_at",
  ).all();
  return rows.results || [];
}

export async function getCredential(d1, id) {
  return (await d1.prepare("SELECT id, public_key, alg FROM webauthn_credentials WHERE id = ?").bind(id).first()) || null;
}

export async function saveCredential(d1, cred) {
  await d1.prepare(
    "INSERT OR REPLACE INTO webauthn_credentials (id, public_key, alg, label, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
  ).bind(cred.id, cred.publicKey, cred.alg, cred.label).run();
}

export async function deleteCredential(d1, id) {
  const res = await d1.prepare("DELETE FROM webauthn_credentials WHERE id = ?").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function touchCredential(d1, id) {
  await d1.prepare("UPDATE webauthn_credentials SET last_used_at = datetime('now') WHERE id = ?").bind(id).run();
}
