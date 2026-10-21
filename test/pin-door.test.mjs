// node --test test/*.test.mjs  NET-02 (2026-10-21): household cap on the PIN door.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/worker.js";
import { GLOBAL_PER_HOUR, globallyThrottled } from "../src/pin-guard.js";

function d1(sqlite) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { prepare: (sql) => stmt(sql), batch: async (l) => Promise.all(l.map((s) => s.run())) };
}
function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync("migrations").sort()) db.exec(readFileSync("migrations/" + f, "utf8"));
  return db;
}
const TEST_PIN = "test-pin-1357";
const env = (db) => ({ DB: d1(db), SESSION_SECRET: "s".repeat(48), LEARN_PIN: TEST_PIN });
const login = (e, pin, ip) => worker.fetch(new Request("https://learn.gaitherstephens.com/login", {
  method: "POST", body: new URLSearchParams({ pin, next: "/" }).toString(),
  headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://learn.gaitherstephens.com", "CF-Connecting-IP": ip },
}), e, { waitUntil() {}, passThroughOnException() {} });

test("the right PIN still signs in", async () => {
  assert.equal((await login(env(freshDb()), TEST_PIN, "192.0.2.1")).status, 303);
});
test(`${GLOBAL_PER_HOUR} failures from many addresses pause the PIN form for everyone`, async () => {
  const e = env(freshDb());
  for (let i = 0; i < GLOBAL_PER_HOUR; i++) assert.equal((await login(e, "0000", `203.0.113.${i}`)).status, 401);
  const held = await login(e, TEST_PIN, "192.0.2.99");
  assert.equal(held.status, 429);
  assert.match(await held.text(), /passkey/);
});
test("the household check refuses when it cannot count", async () => {
  const broken = { prepare: () => ({ first: async () => { throw new Error("D1 down"); } }) };
  assert.equal(await globallyThrottled(broken), true);
});
