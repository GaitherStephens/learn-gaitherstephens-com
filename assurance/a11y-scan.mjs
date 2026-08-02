#!/usr/bin/env node
// Post-hydration axe scan against deployed URLs. Runs in GitHub Actions
// (Playwright is not available in the constrained agent sandbox).
// Reads assurance/a11y-routes.json, scans each route's states, writes
// a11y-report.json and prints a summary. Report-only by default;
// set A11Y_BLOCKING=1 (workflow env) to fail the job on any critical,
// serious, or failed route scan once a site's baseline is clean (per
// the assurance rollout plan). Optionally POSTs a one-row summary to the
// network health ingest endpoint when ASSURANCE_INGEST_URL and
// ASSURANCE_OPS_TOKEN are set.
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";

const cfg = JSON.parse(readFileSync(new URL("./a11y-routes.json", import.meta.url), "utf8"));
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const results = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });

for (const route of cfg.routes) {
  const page = await ctx.newPage();
  try {
    // Cache-bust: the homepage SWR layer can serve a stale copy (old
    // CSS hash) for up to an hour, making the scan measure a previous
    // deploy (caught 2026-07-21: scan reported pre-fix colors after
    // the fix shipped). A unique query param skips the SWR path.
    const bust = route.url + (route.url.includes("?") ? "&" : "?") + "scan=" + Date.now();
    await page.goto(bust, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (route.ready_selector) await page.waitForSelector(route.ready_selector, { state: "attached", timeout: 45000 });
    if (route.settle_ms) await page.waitForTimeout(route.settle_ms);
    for (const state of route.states || [{ id: "default", actions: [] }]) {
      for (const a of state.actions || []) {
        if (a.type === "click") await page.click(a.selector, { timeout: 10000 }).catch(() => {});
        if (a.type === "wait") await page.waitForTimeout(a.ms || 1000);
        if (a.type === "wait_for") await page.waitForSelector(a.selector, { timeout: 15000 }).catch(() => {});
      }
      // Third-party embed internals (YouTube player, Tableau viz) are not
      // ours to fix and drowned real findings (45-node noise). Excluded
      // per SECURITY_BASELINE.md EXC-005; A11Y-003 still requires a
      // meaningful nonvisual alternative for embedded charts, verified
      // manually.
      let builder = new AxeBuilder({ page }).withTags(TAGS).exclude("iframe");
      for (const sel of cfg.exclude || []) builder = builder.exclude(sel);
      const axe = await builder.analyze();
      for (const v of axe.violations) {
        results.push({
          site: cfg.site, route: route.id, state: state.id, rule: v.id,
          impact: v.impact, help: v.helpUrl, description: v.description,
          nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
          node_count: v.nodes.length,
          // axe's per-node failure text carries the ACTUAL rendered
          // colors and ratios for contrast rules — without it every
          // contrast fix is guesswork (added 2026-07-21).
          failure: (v.nodes[0] && v.nodes[0].failureSummary || "").slice(0, 220),
        });
      }
    }
  } catch (e) {
    results.push({ site: cfg.site, route: route.id, state: "scan-error", rule: "SCAN_FAILED", impact: "unknown", description: String(e).slice(0, 200) });
  } finally {
    await page.close();
  }
}
await browser.close();

writeFileSync("a11y-report.json", JSON.stringify({ site: cfg.site, scanned_at: new Date().toISOString(), tags: TAGS, violations: results }, null, 2));
const counts = {};
for (const r of results) counts[r.impact || "unknown"] = (counts[r.impact || "unknown"] || 0) + 1;
const summary = `a11y ${cfg.site}: ${results.length} violation instances ${JSON.stringify(counts)}`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  // Full findings table in the run summary so remediation does not
  // require downloading the artifact zip (agent sessions read the run
  // page, not artifacts).
  let md = summary + "\n\n| route | state | rule | impact | nodes | first target | failure detail |\n|---|---|---|---|---|---|---|\n";
  for (const r of results) {
    const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 90);
    const fcell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 200);
    md += `| ${cell(r.route)} | ${cell(r.state)} | ${cell(r.rule)} | ${cell(r.impact)} | ${cell(r.node_count)} | \`${cell(r.nodes && r.nodes[0] || r.description)}\` | ${fcell(r.failure)} |\n`;
  }
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n", { flag: "a" });
}

// Optional health ingest (single summary row; details stay in the artifact).
const critical = (counts.critical || 0), serious = (counts.serious || 0);
// A route that failed to scan is a monitoring gap, never a pass: a
// first run reported "ok" while every route had silently failed
// behind a bot challenge (2026-07-20). Failed scans force warn.
const scanErrors = results.filter((r) => r.rule === "SCAN_FAILED").length;

const ingest = process.env.ASSURANCE_INGEST_URL, token = process.env.ASSURANCE_OPS_TOKEN;
if (ingest && token) {
  const status = critical > 0 ? "fail" : (serious > 0 || scanErrors > 0) ? "warn" : "ok";
  try {
    const r = await fetch(ingest, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ops-token": token },
      body: JSON.stringify({ snapshots: [{ category: "ci", key: `a11y:${cfg.site}`, status, value: results.length, detail: { subtitle: `axe WCAG2.2AA: ${critical} critical, ${serious} serious, ${counts.moderate || 0} moderate, ${counts.minor || 0} minor` + (scanErrors ? ` · ${scanErrors} route-state scans FAILED` : ""), source: "github-actions" } }] }),
    });
    const bodyText = await r.text();
    if (!r.ok) console.error(`ingest HTTP ${r.status}: ${bodyText.slice(0, 150)}`);
    else console.log("ingest ok:", bodyText.slice(0, 80));
  } catch (e) {
    console.error("ingest failed:", e.message);
  }
}
if (process.env.A11Y_BLOCKING === "1" && (critical > 0 || serious > 0 || scanErrors > 0)) {
  console.error(`BLOCKING: ${critical} critical, ${serious} serious, ${scanErrors} failed route scans (A11Y_BLOCKING=1)`);
  process.exit(1);
}
process.exit(0);
