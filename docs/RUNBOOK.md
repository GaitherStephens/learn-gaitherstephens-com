# learn.gaitherstephens.com runbook

Written 2026-10-23 (STD-32). One user, one Worker (`learn-gaitherstephens`),
one D1 (`learn-db`), one backup bucket (`learn-gaitherstephens-backups`).
Deploy = push to `main` (deploy.yml); `/version` names the live commit.

## Restore from a backup

The Monday 09:00 UTC cron writes `backups/d1/<YYYY-MM-DD>/<table>.jsonl`
(plain JSON Lines, first lines `-- TABLE:` and `-- SCHEMA:` with the CREATE
statement) and a `manifest.json` when every table is in. The gaithernews
restore drill reads the newest complete folder every month and writes
`data/restore-drill:learn` on the admin board; a drill that fails or stops
is the first sign the backup is not restorable.

To restore one table (from a laptop with the account token):

```bash
cd ~/GaitherDyn/learn.gaitherstephens.com
F=backups/d1/2026-10-19      # the folder the board or `wrangler r2 object list` names
T=progress                   # the table
npx wrangler r2 object get "learn-gaitherstephens-backups/$F/$T.jsonl" --file /tmp/$T.jsonl --remote
# the CREATE statement is on the "-- SCHEMA:" line; rows follow, one JSON object each
node -e '
const fs=require("fs");const L=fs.readFileSync("/tmp/'$T'.jsonl","utf8").split("\n");
const schema=L.find(l=>l.startsWith("-- SCHEMA:")).slice(10).trim();
const rows=L.filter(l=>l&&!l.startsWith("--")).map(l=>JSON.parse(l));
const cols=Object.keys(rows[0]||{});
const q=v=>v===null?"NULL":typeof v==="number"?String(v):"\x27"+String(v).replace(/\x27/g,"\x27\x27")+"\x27";
let out=schema.replace(/^CREATE TABLE/,"CREATE TABLE IF NOT EXISTS")+";\n";
for(const r of rows) out+=`INSERT OR REPLACE INTO "'$T'" (${cols.map(c=>`"${c}"`).join(",")}) VALUES (${cols.map(c=>q(r[c])).join(",")});\n`;
fs.writeFileSync("/tmp/'$T'.sql",out);console.log(rows.length,"rows ->","/tmp/'$T'.sql");'
npx wrangler d1 execute learn-db --remote --file /tmp/$T.sql
```

Restore the small tables first (settings, users, credentials), then the big
ones. Never restore over a live table without a fresh backup of it
(`POST /run-backup` with the `x-ops-token` header, or wait for Monday).

## Break-glass: the PIN is off and the passkey device is gone

`/passkey` lets the one user turn the PIN off once her devices carry
passkeys. If those devices are lost:

```bash
npx wrangler d1 execute learn-db --remote --command "UPDATE settings SET value='0' WHERE key='pin_disabled'"
```

The household PIN then works again at `/login` (the hash is in `settings`
under `learn_pin_sha256`; it is the same PIN as every personal app, see
`~/GaitherDyn/standard-snippets/` and the root CLAUDE.md on the household PIN).

## Secrets and rotation

Worker secrets: `SESSION_SECRET` (signs sessions; rotating it signs
everyone out, which is the intended effect), `OPS_TOKEN` (the backup
trigger), `LEARN_PIN` (legacy fallback, unused when the settings hash is
set). Rotate with `npx wrangler secret put <NAME> --name learn-gaitherstephens`
from a terminal; local copies live in `~/GaitherDyn/.gaither-private/`
(never in this repo). After rotating `SESSION_SECRET`, sign in again.

## Where to look

- Admin board tiles: `data/backup:learn` (newest COMPLETE backup age),
  `data/restore-drill:learn` (last drill), `cron/*` liveness.
- `/version` names the live commit; `wrangler deployments list --name learn-gaitherstephens`.
- Sentry project: see `assurance/sites.json` in the gaithernews repo.
