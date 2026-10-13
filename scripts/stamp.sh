#!/usr/bin/env bash
# Stamp a new build version onto every cacheable asset reference.
#
# Run this before EVERY deploy that touches app.js, styles.css, or
# content.json. Browsers cache those hard, and a stale app.js against a fresh
# worker produces bugs that look like logic errors but are not. Chrome in
# particular will keep serving a cached wrong-MIME response through a hard
# reload, so query-string versioning is the only reliable lever.
#
#   ./scripts/stamp.sh          # stamp with the current date and time
#   ./scripts/stamp.sh 1.2.3    # stamp with an explicit version
#
# Touches: public/index.html (styles, app.js, footer version), src/worker.js
# (login page styles), public/app.js (content.json fetch).

set -euo pipefail
cd "$(dirname "$0")/.."

BUILD="${1:-$(date +%Y.%m.%d)-$(date +%H%M)}"

# perl -pi, not sed -i: BSD sed (macOS) reads `sed -i -E` as "backup suffix
# -E", so it left index.html-E, worker.js-E and app.js-E behind (a public/
# one gets served) and stamped only two of the five targets. No backup suffix
# on purpose: the ~/GaitherDyn mount denies deletes, so a backup would be
# undeletable, and one dropped in public/ gets uploaded as a public asset.
if [[ ! "$BUILD" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "stamp: bad version '$BUILD' (letters, digits, . _ - only)" >&2
  exit 1
fi
export BUILD
perl -pi -e 's{/styles\.css\?v=[^"\n]*}{/styles.css?v=$ENV{BUILD}}g' public/index.html src/worker.js
perl -pi -e 's{/app\.js(\?v=[^"\n]*)?"}{/app.js?v=$ENV{BUILD}"}g' public/index.html
perl -pi -e 's{/diagrams\.js(\?v=[^"\n]*)?"}{/diagrams.js?v=$ENV{BUILD}"}g' public/index.html
perl -pi -e 's{/content\.json(\?v=[^"\n]*)?"}{/content.json?v=$ENV{BUILD}"}g' public/app.js
perl -pi -e 's{(class="footer-version"[^>]*>)v[^<\n]*}{${1}v$ENV{BUILD}}' public/index.html

# A silent no-op is how this script failed before, so prove every stamp landed.
fail=0
need() { grep -qF -- "$2" "$1" || { echo "stamp: $1 is missing $2" >&2; fail=1; }; }
need public/index.html "/styles.css?v=$BUILD\""
need public/index.html "/app.js?v=$BUILD\""
need public/index.html "/diagrams.js?v=$BUILD\""
need public/index.html ">v$BUILD<"
need src/worker.js "/styles.css?v=$BUILD\""
need public/app.js "/content.json?v=$BUILD\""
if grep -oE '(styles\.css|app\.js|diagrams\.js|content\.json)\?v=[^"]*' public/index.html src/worker.js public/app.js | grep -vF "?v=$BUILD" >&2; then
  echo "stamp: the references above still carry an old version" >&2; fail=1
fi
[ "$fail" -eq 0 ] || exit 1

echo "stamped build $BUILD"
grep -oE '(styles\.css|app\.js|diagrams\.js|content\.json)\?v=[^"]*' public/index.html src/worker.js public/app.js
