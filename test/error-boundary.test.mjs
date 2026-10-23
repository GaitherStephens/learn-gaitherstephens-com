// The error boundary (audit 2026-10-23): a throw inside the router must come
// back as our 500 with the security headers, never as Cloudflare's bare 1101.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { withBoundary } from "../src/worker.js";

const boom = withBoundary(async () => { throw new Error("deliberate"); });

test("a throw under /api/ is a JSON 500 with the header set and no caching", async () => {
  const res = await boom(new Request("https://learn.gaitherstephens.com/api/progress"), {});
  assert.equal(res.status, 500);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.equal((await res.json()).error, "server_error");
  for (const h of ["strict-transport-security", "content-security-policy", "x-content-type-options"]) {
    assert.ok(res.headers.get(h), `${h} missing`);
  }
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("a throw on a page is a short HTML 500 with the same headers", async () => {
  const res = await boom(new Request("https://learn.gaitherstephens.com/study"), {});
  assert.equal(res.status, 500);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.ok(res.headers.get("strict-transport-security"));
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(await res.text(), /Something broke/);
});

test("the default export's fetch is the boundary around the router", async () => {
  // /health needs no bindings; it proves the real handler runs under the wrapper.
  const res = await worker.fetch(new Request("https://learn.gaitherstephens.com/health"), {});
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
});
