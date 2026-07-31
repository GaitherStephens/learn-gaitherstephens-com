#!/usr/bin/env node
// Critical-journey smoke checks (assurance REL-003). Playwright in CI,
// report-only. Reads assurance/journeys.json: each journey is a list of
// steps (goto / expect_min / click / expect / fill-free). A journey that
// throws is recorded failed; the process still exits 0 in the report-only
// phase. One summary row per site posts to the health ingest when the
// env vars are present (workers.dev host: zone bot protection challenges
// runner traffic).
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const cfg = JSON.parse(readFileSync(new URL("./journeys.json", import.meta.url), "utf8"));
const results = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });

for (const j of cfg.journeys) {
  const page = await ctx.newPage();
  const t0 = Date.now();
  try {
    for (const s of j.steps) {
      if (s.goto) {
        const bust = s.goto + (s.goto.includes("?") ? "&" : "?") + "scan=" + Date.now();
        await page.goto(bust, { waitUntil: "domcontentloaded", timeout: 45000 });
      }
      if (s.wait_for) await page.waitForSelector(s.wait_for, { state: "attached", timeout: 30000 });
      if (s.expect_min) {
        const n = await page.locator(s.expect_min.selector).count();
        if (n < s.expect_min.count) throw new Error(`${s.expect_min.selector}: ${n} < ${s.expect_min.count}`);
      }
      if (s.click) await page.click(s.click, { timeout: 15000 });
      if (s.fill) await page.fill(s.fill.selector, s.fill.value, { timeout: 15000 });
      if (s.expect_text) {
        await page.waitForFunction(
          (arg) => document.body && document.body.innerText.includes(arg),
          s.expect_text, { timeout: 20000 },
        );
      }
      if (s.expect_not_text) {
        const has = await page.evaluate((arg) => document.body.innerText.includes(arg), s.expect_not_text);
        if (has) throw new Error(`page contains forbidden text: ${s.expect_not_text}`);
      }
      if (s.sleep) await page.waitForTimeout(s.sleep);
      // Correctness steps (2026-07-28): journeys previously proved pages
      // LOAD; these prove the content is right.
      if (s.expect_iso_fresh) {
        // Newest ISO timestamp in matching elements' attr must be within
        // N hours — catches "page loads fine but serves stale content"
        // (cache pinned, ingest dead upstream of render).
        const { selector, attr = "data-iso", hours } = s.expect_iso_fresh;
        const isos = await page.$$eval(selector, (els, a) => els.map((e) => e.getAttribute(a)).filter(Boolean), attr);
        if (!isos.length) throw new Error(`expect_iso_fresh: no ${selector}[${attr}] elements`);
        const newest = Math.max(...isos.map((x) => Date.parse(x)).filter(Number.isFinite));
        const ageH = (Date.now() - newest) / 3600000;
        if (!(ageH <= hours)) throw new Error(`expect_iso_fresh: newest ${selector} is ${ageH.toFixed(1)}h old (limit ${hours}h)`);
      }
      if (s.goto_first_href) {
        const href = await page.locator(s.goto_first_href.selector).first().getAttribute("href");
        if (!href) throw new Error(`goto_first_href: no ${s.goto_first_href.selector}`);
        const abs = new URL(href, page.url()).toString();
        await page.goto(abs + (abs.includes("?") ? "&" : "?") + "scan=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 45000 });
      }
      if (s.expect_json) {
        const { url, required = [], status = 200 } = s.expect_json;
        const resp = await page.request.get(new URL(url, page.url()).toString());
        if (resp.status() !== status) throw new Error(`expect_json ${url}: HTTP ${resp.status()} != ${status}`);
        let body;
        try { body = await resp.json(); } catch { throw new Error(`expect_json ${url}: response is not JSON`); }
        for (const k of required) {
          if (body?.[k] === undefined) throw new Error(`expect_json ${url}: missing key ${k}`);
        }
      }
    }
    results.push({ id: j.id, ok: true, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ id: j.id, ok: false, ms: Date.now() - t0, error: String(e).slice(0, 180) });
  } finally {
    await page.close();
  }
}
await browser.close();

writeFileSync("journeys-report.json", JSON.stringify({ site: cfg.site, at: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => !r.ok);
const summary = `journeys ${cfg.site}: ${results.length - failed.length}/${results.length} passed` +
  (failed.length ? ` — FAILED: ${failed.map((f) => f.id).join(", ")}` : "");
console.log(summary);
for (const f of failed) console.log(`  ${f.id}: ${f.error}`);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n", { flag: "a" });

const ingest = process.env.ASSURANCE_INGEST_URL, token = process.env.ASSURANCE_OPS_TOKEN;
if (ingest && token) {
  try {
    const r = await fetch(ingest, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ops-token": token },
      body: JSON.stringify({ snapshots: [{ category: "ci", key: `journeys:${cfg.site}`, status: failed.length ? "warn" : "ok", value: failed.length, detail: { subtitle: summary.slice(0, 300), source: "github-actions" } }] }),
    });
    console.log("ingest:", r.status, (await r.text()).slice(0, 60));
  } catch (e) { console.error("ingest failed:", e.message); }
}
process.exit(0);
