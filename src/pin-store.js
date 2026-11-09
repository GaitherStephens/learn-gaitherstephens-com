// Household PIN storage. ONE TEXT: this file is byte-identical in learn, house,
// money, recipes, piano and media. Change it in one, copy it to the other five.
//
// The setting `<site>_pin_sha256` keeps its old name and holds one of three
// forms, told apart by how the value starts:
//
//   pbkdf2p$<iterations>$<b64 salt>$<b64 hash>   peppered
//   pbkdf2$<iterations>$<b64 salt>$<b64 hash>    salted only
//   anything else                                legacy unsalted SHA-256 hex
//
// Peppered means PBKDF2-SHA256 whose password input is
// HMAC-SHA256(PIN_PEPPER, pin). PIN_PEPPER is an optional Worker secret, so a
// copy of the database or a backup alone is not enough to guess the PIN.
//
// A value is verified against the iteration count written inside it, so the
// count for new values can change later without touching old ones. New values
// use 100000 so that a Workers cap on PBKDF2 cannot throw in the verify path.
//
// Never check the length or shape of a legacy value. It arrived already made
// from another app, and a shape rule here locks people out of a working PIN.

const enc = new TextEncoder();

export const PIN_ITERATIONS = 100000;

// A corrupt count must not run the Worker out of CPU, where no catch can help.
const MIN_ITERATIONS = 1000;
const MAX_ITERATIONS = 1000000;

const PEPPERED = "pbkdf2p$";
const SALTED = "pbkdf2$";

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function pepperIsSet(pepper) {
  return typeof pepper === "string" && pepper.length > 0;
}

function errorName(e) {
  return e && e.name ? e.name : "Error";
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function derive(pin, salt, iterations, pepper) {
  let password = enc.encode(pin);
  if (pepper) {
    const hmacKey = await crypto.subtle.importKey("raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    password = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, password));
  }
  const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return b64(new Uint8Array(bits));
}

/** The best stored form available: peppered when PIN_PEPPER is set, otherwise salted. */
export async function hashPinForStorage(pin, pepper) {
  const peppered = pepperIsSet(pepper);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, PIN_ITERATIONS, peppered ? pepper : null);
  return `${peppered ? PEPPERED : SALTED}${PIN_ITERATIONS}$${b64(salt)}$${hash}`;
}

// False for a wrong PIN and for a value that cannot be read. Never throws: a
// throw would land in the caller's catch and fall through to another way in.
async function verifySalted(attempted, stored, pepper, key) {
  try {
    const parts = stored.split("$");
    if (parts.length !== 4 || !/^[1-9][0-9]*$/.test(parts[1])) {
      console.error(`PIN setting ${key} is malformed. Refusing the sign-in.`);
      return false;
    }
    const iterations = Number(parts[1]);
    const salt = unb64(parts[2]);
    if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS || salt.length === 0 || parts[3] === "") {
      console.error(`PIN setting ${key} is malformed. Refusing the sign-in.`);
      return false;
    }
    return constantEqual(await derive(attempted, salt, iterations, pepper), parts[3]);
  } catch (e) {
    console.error(`PIN check for ${key} could not run (${errorName(e)}). Refusing the sign-in.`);
    return false;
  }
}

// Best effort, after the PIN has already been proved right, so a failure here
// never fails the sign-in. The WHERE on the old value means a PIN changed by
// someone else in the meantime is not overwritten.
async function rewrite(d1, key, stored, attempted, pepper) {
  try {
    const value = await hashPinForStorage(attempted, pepper);
    await d1.prepare("UPDATE settings SET value = ? WHERE key = ? AND value = ?").bind(value, key, stored).run();
  } catch (e) {
    console.error(`PIN upgrade for ${key} did not save (${errorName(e)}). The sign-in still succeeds.`);
  }
}

/**
 * Is `attempted` the PIN behind `stored`? On a right PIN, an older form is
 * rewritten to the best form available. Never throws.
 */
export async function checkPinAndUpgrade(d1, key, stored, attempted, pepper) {
  if (typeof attempted !== "string" || attempted === "" || typeof stored !== "string" || stored === "") return false;

  if (stored.startsWith(PEPPERED)) {
    if (!pepperIsSet(pepper)) {
      console.error(`PIN setting ${key} is peppered but PIN_PEPPER is not set on this Worker. Refusing the sign-in. Restore the secret.`);
      return false;
    }
    return verifySalted(attempted, stored, pepper, key);
  }

  if (stored.startsWith(SALTED)) {
    const ok = await verifySalted(attempted, stored, null, key);
    if (ok && pepperIsSet(pepper)) await rewrite(d1, key, stored, attempted, pepper);
    return ok;
  }

  // Legacy compares first and owes nothing to the new hashing path, so a
  // failure over there cannot lock out a correct legacy PIN.
  let ok = false;
  try {
    ok = constantEqual(await sha256Hex(attempted), stored);
  } catch (e) {
    console.error(`PIN check for ${key} could not run (${errorName(e)}). Refusing the sign-in.`);
    return false;
  }
  if (ok) await rewrite(d1, key, stored, attempted, pepper);
  return ok;
}
