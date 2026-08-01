// D1 -> R2 backup for learn (STD-22 / STD-23).
//
// Direct port of house's src/lib/backup.ts, same discipline, same
// reasoning. Cloudflare's Time Travel gives 30 days; this adds an
// external copy that outlives it, into a bucket this app owns
// (learn-gaitherstephens-backups; learn has no other R2 use).
//
// Written after the gaithernews backup was found to have silently
// degraded for six weeks. Lessons applied here, identically to house:
//
//  - RESUMABLE: each run backs up only tables missing from the current
//    folder, so a run that dies still banks progress.
//  - SMALLEST-FIRST: the small tables are the irreplaceable ones
//    (state = Meg's entire study history, settings = the PIN hash,
//    webauthn_credentials = her passkeys).
//  - manifest.json is written ONLY when every table is present, so its
//    existence means "complete" and a half-finished folder can never
//    look healthy.
//  - Keyset pagination on rowid (LIMIT/OFFSET degrades quadratically).
//  - The result is REPORTED to the shared health collector
//    (data / backup:learn), because a backup nobody is watching is how
//    the last one died unnoticed.

const R2_PREFIX = "backups/d1/";
const RETENTION_DAYS = 120;
const PAGE_SIZE = 500;
const BUDGET_MS = 20_000;
// d1_migrations IS backed up here (unlike house): it is 2 rows and makes
// a restore self-describing. _cf_KV is Cloudflare-internal, skip it.
const SKIP = new Set(["_cf_KV"]);

export async function runLearnBackup(env) {
  const started = Date.now();
  const outOfBudget = () => Date.now() - started > BUDGET_MS;
  const today = new Date().toISOString().slice(0, 10);

  // Resume the newest UNFINISHED folder rather than orphaning it.
  let date = today;
  {
    const complete = new Set();
    const started_ = new Set();
    let c;
    do {
      const l = await env.BACKUPS.list({ prefix: R2_PREFIX, cursor: c, limit: 1000 });
      for (const o of l.objects) {
        const m = String(o.key).match(/^backups\/d1\/(\d{4}-\d{2}-\d{2})\/(.+)$/);
        if (!m) continue;
        started_.add(m[1]);
        if (m[2] === "manifest.json") complete.add(m[1]);
      }
      c = l.truncated ? l.cursor : undefined;
    } while (c);
    const unfinished = [...started_].filter((d) => !complete.has(d)).sort().pop();
    if (unfinished && (Date.now() - Date.parse(unfinished + "T00:00:00Z")) / 86400000 <= 10) {
      date = unfinished;
    }
  }
  const folder = `${R2_PREFIX}${date}/`;

  const all = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all();
  const tables = (all.results ?? [])
    .map((r) => r.name)
    .filter((t) => !SKIP.has(t) && !t.startsWith("_cf_"));

  const done = new Set();
  {
    let c;
    do {
      const l = await env.BACKUPS.list({ prefix: folder, cursor: c });
      for (const o of l.objects) {
        const m = String(o.key).slice(folder.length).match(/^(.+)\.jsonl$/);
        if (m) done.add(m[1]);
      }
      c = l.truncated ? l.cursor : undefined;
    } while (c);
  }

  // Smallest first: a tick that dies still banks the irreplaceable
  // little tables before the big ones.
  const pending = tables.filter((t) => !done.has(t));
  const sizes = new Map();
  for (const t of pending) {
    try {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).first();
      sizes.set(t, Number(row?.n ?? 0));
    } catch { sizes.set(t, Number.MAX_SAFE_INTEGER); }
  }
  pending.sort((a, b) => (sizes.get(a) ?? 0) - (sizes.get(b) ?? 0));

  let written = 0, rows = 0, skipped = 0;
  for (const table of pending) {
    if (outOfBudget()) { skipped++; continue; }
    const schema = await env.DB
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?1`)
      .bind(table).first();
    let out = `-- TABLE: ${table}\n-- SCHEMA: ${(schema?.sql ?? "").trim()}\n-- generated ${new Date().toISOString()}\n`;
    let last = 0, n = 0;
    while (true) {
      const page = await env.DB
        .prepare(`SELECT rowid AS __rid, * FROM "${table}" WHERE rowid > ?1 ORDER BY rowid LIMIT ?2`)
        .bind(last, PAGE_SIZE).all();
      const rs = page.results ?? [];
      if (!rs.length) break;
      for (const r of rs) { last = Number(r.__rid); delete r.__rid; out += JSON.stringify(r) + "\n"; }
      n += rs.length;
      if (rs.length < PAGE_SIZE) break;
    }
    await env.BACKUPS.put(folder + table + ".jsonl", out, {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
    written++; rows += n;
  }

  const complete = skipped === 0;
  if (complete) {
    const inventory = [];
    let c;
    do {
      const l = await env.BACKUPS.list({ prefix: folder, cursor: c });
      for (const o of l.objects) {
        const m = String(o.key).slice(folder.length).match(/^(.+)\.jsonl$/);
        if (m) inventory.push({ table: m[1], bytes: Number(o.size ?? 0) });
      }
      c = l.truncated ? l.cursor : undefined;
    } while (c);
    await env.BACKUPS.put(folder + "manifest.json", JSON.stringify({
      generated: new Date().toISOString(), db: "learn-db",
      tables_total: tables.length, inventory, retention_days: RETENTION_DAYS,
    }, null, 2), { httpMetadata: { contentType: "application/json" } });

    // Rotate old folders.
    const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
    let cur;
    do {
      const l = await env.BACKUPS.list({ prefix: R2_PREFIX, cursor: cur });
      for (const o of l.objects) {
        if (o.uploaded && o.uploaded.getTime() < cutoff) await env.BACKUPS.delete(o.key);
      }
      cur = l.truncated ? l.cursor : undefined;
    } while (cur);
  }

  const summary = complete
    ? `[learn-backup] COMPLETE ${folder} — ${written} written this run, ${tables.length} tables, ${rows} rows`
    : `[learn-backup] PARTIAL ${folder} — ${written} written, ${skipped} left for next run`;

  // Report to the shared collector so a stalled backup is VISIBLE.
  if (complete && env.OPS_INGEST_URL && env.OPS_TOKEN) {
    const ageDays = Math.floor((Date.now() - Date.parse(date + "T00:00:00Z")) / 86400000);
    try {
      await fetch(env.OPS_INGEST_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ops-token": env.OPS_TOKEN },
        body: JSON.stringify({ snapshots: [{
          category: "data", key: "backup:learn", status: ageDays > 16 ? "fail" : ageDays > 9 ? "warn" : "ok",
          value: ageDays,
          detail: { subtitle: `newest COMPLETE learn-db backup ${date} (${ageDays}d) · ${tables.length} tables · weekly Mon 09 UTC · warn >9d, fail >16d` },
        }] }),
      });
    } catch { /* reporting must never fail the backup */ }
  }
  return summary;
}
