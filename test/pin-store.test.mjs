// The stored household PIN: three forms, the upgrade path, and the ways a row
// can be broken. Made-up test PINs and pepper only. Expected values are built
// here with node:crypto, independently of the code under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { PIN_ITERATIONS, checkPinAndUpgrade, hashPinForStorage } from "../src/pin-store.js";

const KEY = "test_pin_sha256";
const PIN = "made-up-pin-8642";
const WRONG = "made-up-pin-8643";
const PEPPER = "made-up-pepper-for-tests-only";
const OTHER_PEPPER = "a-different-made-up-pepper";

const legacy = (pin) => createHash("sha256").update(pin, "utf8").digest("hex");

function password(pin, pepper) {
  return pepper ? createHmac("sha256", pepper).update(pin, "utf8").digest() : Buffer.from(pin, "utf8");
}
function made(pin, iterations, pepper) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password(pin, pepper), salt, iterations, 32, "sha256");
  return `${pepper ? "pbkdf2p" : "pbkdf2"}$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}`;
}
const peppered = (pin, pepper = PEPPER, iterations = PIN_ITERATIONS) => made(pin, iterations, pepper);
const salted = (pin, iterations = PIN_ITERATIONS) => made(pin, iterations, null);

// A value this code wrote must be exactly the agreed format, proved from outside.
function assertForm(value, pin, pepper) {
  const parts = value.split("$");
  assert.equal(parts.length, 4);
  assert.equal(parts[0], pepper ? "pbkdf2p" : "pbkdf2");
  assert.equal(parts[1], "100000");
  const salt = Buffer.from(parts[2], "base64");
  assert.equal(salt.length, 16);
  assert.equal(Buffer.from(parts[3], "base64").length, 32);
  assert.equal(pbkdf2Sync(password(pin, pepper), salt, 100000, 32, "sha256").toString("base64"), parts[3]);
}

// Stands in for D1 and holds the rule the real SQL carries: only the old value is replaced.
function row(initial, fail = null) {
  const state = { value: initial, writes: 0 };
  state.d1 = {
    prepare: (sql) => {
      if (fail === "prepare") throw new Error("D1 down");
      assert.equal(sql, "UPDATE settings SET value = ? WHERE key = ? AND value = ?");
      return {
        bind: (...a) => ({
          run: async () => {
            if (fail === "run") throw new Error("D1 down");
            state.writes++;
            if (a[1] === KEY && a[2] === state.value) state.value = a[0];
            return {};
          },
        }),
      };
    },
  };
  return state;
}
const check = (r, attempted, pepper = undefined) => checkPinAndUpgrade(r.d1, KEY, r.value, attempted, pepper);

// Runs fn with console.error captured, so an expected refusal stays out of the gate log.
async function logged(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...a) => { lines.push(a.join(" ")); };
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
}

test("new values are the agreed format, peppered only when a pepper is there", async () => {
  assertForm(await hashPinForStorage(PIN, PEPPER), PIN, PEPPER);
  assertForm(await hashPinForStorage(PIN, undefined), PIN, null);
  assertForm(await hashPinForStorage(PIN, ""), PIN, null);
  assert.notEqual(await hashPinForStorage(PIN, PEPPER), await hashPinForStorage(PIN, PEPPER), "a fresh salt every time");
});

test("legacy: the right PIN signs in and upgrades to peppered when the pepper is there", async () => {
  const r = row(legacy(PIN));
  assert.equal(await check(r, PIN, PEPPER), true);
  assertForm(r.value, PIN, PEPPER);
  assert.equal(await check(r, PIN, PEPPER), true, "the upgraded value still opens");
  assert.equal(r.writes, 1, "and is not rewritten again");
});

test("legacy: the right PIN upgrades to salted when there is no pepper", async () => {
  const r = row(legacy(PIN));
  assert.equal(await check(r, PIN), true);
  assertForm(r.value, PIN, null);
});

test("legacy: a wrong PIN is refused and nothing is written", async () => {
  const stored = legacy(PIN);
  const r = row(stored);
  assert.equal(await check(r, WRONG, PEPPER), false);
  assert.equal(r.value, stored);
  assert.equal(r.writes, 0);
});

test("legacy: the shape of the stored value is nobody's business", async () => {
  // A short PIN, as the household's may be, signs in like any other.
  const r = row(legacy("4242"));
  assert.equal(await check(r, "4242", PEPPER), true);
  assertForm(r.value, "4242", PEPPER);
  // A value that is no digest at all cannot match, and does not throw.
  for (const odd of ["deadbeef", "z".repeat(64), "pbkdf2", "PBKDF2$100000$c2FsdA==$aGFzaA==", " "]) {
    const bad = row(odd);
    assert.equal(await check(bad, PIN, PEPPER), false, odd);
    assert.equal(bad.writes, 0, odd);
  }
});

test("salted: the right PIN signs in and is left alone without a pepper", async () => {
  const stored = salted(PIN);
  const r = row(stored);
  assert.equal(await check(r, PIN), true);
  assert.equal(r.value, stored);
  assert.equal(r.writes, 0);
});

test("salted: a wrong PIN is refused and nothing is written", async () => {
  const stored = salted(PIN);
  const r = row(stored);
  assert.equal(await check(r, WRONG), false);
  assert.equal(await check(r, WRONG, PEPPER), false);
  assert.equal(r.value, stored);
  assert.equal(r.writes, 0);
});

test("salted: upgrades to peppered when the pepper appears", async () => {
  const r = row(salted(PIN));
  assert.equal(await check(r, PIN, PEPPER), true);
  assertForm(r.value, PIN, PEPPER);
});

test("peppered: the right PIN signs in and is left alone", async () => {
  const stored = peppered(PIN);
  const r = row(stored);
  assert.equal(await check(r, PIN, PEPPER), true);
  assert.equal(r.value, stored);
  assert.equal(r.writes, 0);
});

test("peppered: a wrong PIN or a different pepper is refused", async () => {
  const stored = peppered(PIN);
  const r = row(stored);
  assert.equal(await check(r, WRONG, PEPPER), false);
  assert.equal(await check(r, PIN, OTHER_PEPPER), false);
  assert.equal(r.value, stored);
  assert.equal(r.writes, 0);
});

test("peppered with the pepper missing is refused, loudly, and names no secret", async () => {
  const stored = peppered(PIN);
  for (const missing of [undefined, null, ""]) {
    const r = row(stored);
    const { result, lines } = await logged(() => check(r, PIN, missing));
    assert.equal(result, false);
    assert.equal(r.writes, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /PIN_PEPPER is not set/);
    assert.ok(!lines[0].includes(stored) && !lines[0].includes(PIN), "the log carries neither the value nor the PIN");
  }
});

test("a failed upgrade write never fails the sign-in", async () => {
  for (const fail of ["run", "prepare"]) {
    for (const stored of [legacy(PIN), salted(PIN)]) {
      const r = row(stored, fail);
      const { result, lines } = await logged(() => check(r, PIN, PEPPER));
      assert.equal(result, true, fail);
      assert.equal(r.value, stored);
      assert.match(lines[0], /did not save/);
      assert.ok(!lines[0].includes(PIN));
    }
  }
});

test("the new hashing path blowing up cannot lock out a correct legacy PIN", async () => {
  const subtle = crypto.subtle;
  Object.defineProperty(subtle, "deriveBits", { configurable: true, value: async () => { throw new Error("PBKDF2 refused"); } });
  try {
    const stored = legacy(PIN);
    const r = row(stored);
    const { result } = await logged(() => check(r, PIN, PEPPER));
    assert.equal(result, true);
    assert.equal(r.value, stored, "no half-made value is stored");
    // The same failure on a salted value refuses, and does not throw into the caller.
    const { result: refused } = await logged(() => check(row(salted(PIN)), PIN, PEPPER));
    assert.equal(refused, false);
  } finally {
    delete subtle.deriveBits;
  }
});

test("empty PIN input is refused against every form", async () => {
  for (const stored of [legacy(""), legacy(PIN), salted(PIN), peppered(PIN)]) {
    const r = row(stored);
    assert.equal(await check(r, "", PEPPER), false);
    assert.equal(r.writes, 0);
  }
  for (const notText of [undefined, null, 42, {}]) assert.equal(await check(row(legacy(PIN)), notText, PEPPER), false);
  for (const noValue of ["", null, undefined]) assert.equal(await checkPinAndUpgrade(row("x").d1, KEY, noValue, PIN, PEPPER), false);
});

test("very long PIN input: wrong is refused without a write, right still works", async () => {
  const long = "9".repeat(1000000);
  for (const stored of [legacy(PIN), salted(PIN), peppered(PIN)]) {
    const r = row(stored);
    assert.equal(await check(r, long, PEPPER), false);
    assert.equal(r.writes, 0);
  }
  const r = row(legacy(long));
  assert.equal(await check(r, long, PEPPER), true);
  assertForm(r.value, long, PEPPER);
  assert.equal(await check(r, long, PEPPER), true);
});

test("a PIN outside plain ASCII goes through every form", async () => {
  const pin = "pîn-\u{1F511}-8642";
  const r = row(legacy(pin));
  assert.equal(await check(r, pin), true);
  assertForm(r.value, pin, null);
  assert.equal(await check(r, pin, PEPPER), true);
  assertForm(r.value, pin, PEPPER);
  assert.equal(await check(r, pin, PEPPER), true);
});

test("malformed salted and peppered values are refused without throwing", async () => {
  const good = salted(PIN).split("$");
  const tails = [
    "",
    "$",
    "$$",
    "$$$",
    "$$$$",
    "100000",
    "100000$",
    `100000$${good[2]}`,
    `100000$${good[2]}$`,
    `100000$$${good[3]}`,
    `$${good[2]}$${good[3]}`,
    `x$${good[2]}$${good[3]}`,
    `0$${good[2]}$${good[3]}`,
    `-1$${good[2]}$${good[3]}`,
    `999$${good[2]}$${good[3]}`,
    `1e5$${good[2]}$${good[3]}`,
    `0x186a0$${good[2]}$${good[3]}`,
    `100000.5$${good[2]}$${good[3]}`,
    ` 100000$${good[2]}$${good[3]}`,
    `1000001$${good[2]}$${good[3]}`,
    `99999999999999999999$${good[2]}$${good[3]}`,
    `100000$not base64!$${good[3]}`,
    `100000$${good[2]}$not base64!`,
    `100000$${good[2]}$${good[3]}$extra`,
  ];
  for (const prefix of ["pbkdf2$", "pbkdf2p$"]) {
    for (const tail of tails) {
      const r = row(prefix + tail);
      const { result } = await logged(() => check(r, PIN, PEPPER));
      assert.equal(result, false, prefix + tail);
      assert.equal(r.writes, 0, prefix + tail);
    }
  }
});

test("a correctly made value outside the iteration limits is refused", async () => {
  for (const iterations of [999, 1000001]) {
    const r = row(salted(PIN, iterations));
    const { result } = await logged(() => check(r, PIN));
    assert.equal(result, false, `salted at ${iterations}`);
    assert.equal(r.writes, 0);
    const p = row(peppered(PIN, PEPPER, iterations));
    const { result: pepperedResult } = await logged(() => check(p, PIN, PEPPER));
    assert.equal(pepperedResult, false, `peppered at ${iterations}`);
    assert.equal(p.writes, 0);
  }
});

test("the iteration count is read from the value", async () => {
  for (const iterations of [1000, 5000, 210000]) {
    assert.equal(await check(row(salted(PIN, iterations)), PIN), true, `salted at ${iterations}`);
    assert.equal(await check(row(peppered(PIN, PEPPER, iterations)), PIN, PEPPER), true, `peppered at ${iterations}`);
  }
  const edited = salted(PIN, 5000).replace("$5000$", "$5001$");
  assert.equal(await check(row(edited), PIN), false, "the number in the value is what gets used");
  // Media's personal format at its own count verifies as the salted form.
  assert.equal(salted(PIN, 210000).startsWith("pbkdf2$210000$"), true);
});

test("a value already salted keeps its old count until it is upgraded by a pepper", async () => {
  const stored = salted(PIN, 5000);
  const r = row(stored);
  assert.equal(await check(r, PIN), true);
  assert.equal(r.value, stored);
  assert.equal(await check(r, PIN, PEPPER), true);
  assertForm(r.value, PIN, PEPPER);
});
