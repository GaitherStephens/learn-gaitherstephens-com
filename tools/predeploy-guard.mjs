// Gaither site standard: the predeploy guard. MASTER COPY in
// standard-snippets/predeploy-guard.mjs; each hand-deployed repo carries a byte
// copy as tools/predeploy-guard.mjs and runs it first in its deploy script.
//
// Why: wrangler deploys whatever tree it stands in. On 2026-07-30 a nine-day-
// stale clone was deployed over office and took routes down for 20 minutes.
// This refuses to deploy anything GitHub does not already have: a dirty tree,
// a HEAD that is not origin/main, an unpushed HEAD, or a tree with no git at
// all. On success it prints the short SHA, which the deploy script passes to
// wrangler as --var COMMIT_SHA and --message, so /version and the deployment
// list both name the commit.
//
//   node tools/predeploy-guard.mjs            refuse or print the sha
//   node tools/predeploy-guard.mjs --sha      print only the sha (for $(...))
//   PREDEPLOY_BRANCH=master node ...          repos whose default is not main
import { execSync } from "node:child_process";

const quiet = process.argv.includes("--sha");
const branch = process.env.PREDEPLOY_BRANCH || "main";
const sh = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const refuse = (why) => { console.error("predeploy-guard: REFUSED. " + why); process.exit(1); };

let head;
try { head = sh("git rev-parse HEAD"); } catch { refuse("not a git checkout; deploy from a fresh clone of origin."); }
try { sh("git fetch -q origin " + branch); } catch { refuse("cannot fetch origin/" + branch + "; a deploy must be checked against GitHub."); }
const dirty = sh("git status --porcelain --untracked-files=no");
if (dirty) refuse("the tree has uncommitted changes:\n" + dirty);
const origin = sh("git rev-parse origin/" + branch);
if (head !== origin) {
  let ahead = "?", behind = "?";
  try { [behind, ahead] = sh("git rev-list --left-right --count origin/" + branch + "...HEAD").split(/\s+/); } catch {}
  refuse(`HEAD ${head.slice(0, 7)} is not origin/${branch} ${origin.slice(0, 7)} (${ahead} unpushed, ${behind} behind). Push first, or pull.`);
}
const sha = head.slice(0, 7);
if (quiet) { process.stdout.write(sha); } else { console.log("predeploy-guard: ok, deploying " + sha + " (origin/" + branch + ")"); }
