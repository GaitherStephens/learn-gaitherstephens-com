// The PIN door end to end: the real Worker on SQLite built from migrations/, for
// every stored form of the household PIN. Made-up test PINs and pepper only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/worker.js";

const SETTING = "learn_pin_sha256";
const PIN = "4242-made-up";
const WRONG = "9999-made-up";
const PEPPER = "made-up-pepper-for-tests-only";

const legacy = (pin) => createHash("sha256").update(pin, "utf8").digest("hex");
function made(pin, pepper) {
  const salt = randomBytes(16);
  const password = pepper ? createHmac("sha256", pepper).update(pin, "utf8").digest() : Buffer.from(pin, "utf8");
  const hash = pbkdf2Sync(password, salt, 100000, 32, "sha256");
  return `${pepper ? "pbkdf2p" : "pbkdf2"}$100000$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function d1(sqlite, failUpdate) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => {
      if (failUpdate && sql.startsWith("UPDATE settings SET value")) throw new Error("D1 down");
      const r = sqlite.prepare(sql).run(...args);
      return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return { prepare: (sql) => stmt(sql), batch: async (l) => Promise.all(l.map((s) => s.run())) };
}
function freshDb(stored) {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").sort()) db.exec(readFileSync("migrations/" + f, "utf8"));
  if (stored !== undefined) db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING, stored);
  return db;
}
const value = (db) => db.prepare("SELECT value FROM settings WHERE key = ?").get(SETTING)?.value;
const env = (db, extra = {}, failUpdate = false) => ({ DB: d1(db, failUpdate), SESSION_SECRET: "s".repeat(48), ...extra });
const origin = "https://learn.gaitherstephens.com";
const ctx = { waitUntil() {}, passThroughOnException() {} };
let n = 0;
const login = (e, pin) => worker.fetch(new Request(origin + "/login", {
  method: "POST", body: new URLSearchParams({ pin, next: "/" }).toString(),
  headers: { "content-type": "application/x-www-form-urlencoded", origin, "CF-Connecting-IP": `198.51.100.${++n % 250}` },
}), e, ctx);
const quietly = async (fn) => {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
};

test("legacy row: the right PIN signs in and the row upgrades to peppered", async () => {
  const db = freshDb(legacy(PIN));
  assert.equal((await login(env(db, { PIN_PEPPER: PEPPER }), PIN)).status, 303);
  assert.match(value(db), /^pbkdf2p\$100000\$/);
  assert.equal((await login(env(db, { PIN_PEPPER: PEPPER }), PIN)).status, 303, "and the upgraded row still opens");
});
test("legacy row: with no pepper the row upgrades to salted", async () => {
  const db = freshDb(legacy(PIN));
  assert.equal((await login(env(db), PIN)).status, 303);
  assert.match(value(db), /^pbkdf2\$100000\$/);
});
test("legacy row: a wrong PIN is refused, the row is not touched, the attempt is counted", async () => {
  const stored = legacy(PIN);
  const db = freshDb(stored);
  assert.equal((await login(env(db, { PIN_PEPPER: PEPPER }), WRONG)).status, 401);
  assert.equal(value(db), stored);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM login_attempts").get().c, 1);
});
test("salted row: right signs in and upgrades when the pepper appears, wrong is refused", async () => {
  const stored = made(PIN, null);
  const db = freshDb(stored);
  assert.equal((await login(env(db), PIN)).status, 303);
  assert.equal(value(db), stored, "left alone without a pepper");
  assert.equal((await login(env(db, { PIN_PEPPER: PEPPER }), WRONG)).status, 401);
  assert.equal(value(db), stored);
  assert.equal((await login(env(db, { PIN_PEPPER: PEPPER }), PIN)).status, 303);
  assert.match(value(db), /^pbkdf2p\$/);
});
test("peppered row: right signs in, wrong is refused", async () => {
  const stored = made(PIN, PEPPER);
  const db = freshDb(stored);
  assert.equal((await login(env(db, { PIN_PEPPER: PEPPER }), PIN)).status, 303);
  assert.equal((await login(env(db, { PIN_PEPPER: PEPPER }), WRONG)).status, 401);
  assert.equal(value(db), stored);
});
test("peppered row with the pepper missing refuses, and never falls through to the env PIN", async () => {
  const stored = made(PIN, PEPPER);
  const db = freshDb(stored);
  const res = await quietly(() => login(env(db, { LEARN_PIN: PIN }), PIN));
  assert.equal(res.status, 401);
  assert.equal(value(db), stored);
});
test("a malformed salted row refuses, and never falls through to the env PIN", async () => {
  for (const bad of ["pbkdf2$", "pbkdf2$100000$$", "pbkdf2p$x$c2FsdA==$aGFzaA==", "pbkdf2$100000$not base64!$aGFzaA=="]) {
    const db = freshDb(bad);
    const res = await quietly(() => login(env(db, { LEARN_PIN: PIN, PIN_PEPPER: PEPPER }), PIN));
    assert.equal(res.status, 401, bad);
    assert.equal(value(db), bad);
  }
});
test("a failed upgrade write still signs in", async () => {
  const stored = legacy(PIN);
  const db = freshDb(stored);
  const res = await quietly(() => login(env(db, { PIN_PEPPER: PEPPER }, true), PIN));
  assert.equal(res.status, 303);
  assert.equal(value(db), stored);
});
test("no row at all still uses the env PIN, and writes nothing", async () => {
  const db = freshDb();
  assert.equal((await login(env(db, { LEARN_PIN: PIN, PIN_PEPPER: PEPPER }), PIN)).status, 303);
  assert.equal(value(db), undefined);
});
test("a retired PIN is refused and not upgraded", async () => {
  const stored = legacy(PIN);
  const db = freshDb(stored);
  db.prepare("INSERT INTO settings (key, value) VALUES ('pin_disabled', '1')").run();
  assert.equal((await login(env(db, { PIN_PEPPER: PEPPER }), PIN)).status, 401);
  assert.equal(value(db), stored);
});
test("empty and very long PIN input are refused and write nothing", async () => {
  const stored = legacy(PIN);
  for (const pin of ["", "1".repeat(100000)]) {
    const db = freshDb(stored);
    assert.equal((await login(env(db, { PIN_PEPPER: PEPPER }), pin)).status, 401);
    assert.equal(value(db), stored);
  }
});
async function changePin(e, cookie, pin) {
  return worker.fetch(new Request(origin + "/api/auth/pin", {
    method: "POST", body: JSON.stringify({ pin }),
    headers: { "content-type": "application/json", origin, cookie, "CF-Connecting-IP": "192.0.2.200" },
  }), e, ctx);
}
for (const [label, extra, form] of [["peppered", { PIN_PEPPER: PEPPER }, /^pbkdf2p\$100000\$/], ["salted", {}, /^pbkdf2\$100000\$/]]) {
  test(`the PIN-change route stores the best form available: ${label}`, async () => {
    const db = freshDb(legacy(PIN));
    const e = env(db, extra);
    const signedIn = await login(e, PIN);
    assert.equal(signedIn.status, 303);
    const cookie = signedIn.headers.get("set-cookie").split(";")[0];
    const newPin = "246813";
    assert.equal((await changePin(e, cookie, newPin)).status, 200);
    assert.match(value(db), form);
    assert.equal((await login(e, newPin)).status, 303, "the new PIN opens");
    assert.equal((await login(e, PIN)).status, 401, "the old one does not");
  });
}
