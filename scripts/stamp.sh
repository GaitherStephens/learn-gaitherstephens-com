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

# NO -i.bak here. The ~/GaitherDyn mount allows create and rename but DENIES
# deletes from the sandbox, so a .bak would be undeletable, and one dropped in
# public/ gets uploaded as a public asset. Edit in place, no backups.
sed -i -E "s|/styles\.css\?v=[^\"]*|/styles.css?v=$BUILD|g" public/index.html src/worker.js
sed -i -E "s|/app\.js(\?v=[^\"]*)?\"|/app.js?v=$BUILD\"|g" public/index.html
sed -i -E "s|/content\.json(\?v=[^\"]*)?\"|/content.json?v=$BUILD\"|g" public/app.js
sed -i -E "s|(class=\"footer-version\"[^>]*>)v[^<]*|\1v$BUILD|" public/index.html

echo "stamped build $BUILD"
grep -oE '(styles\.css|app\.js|content\.json)\?v=[^"]*' public/index.html src/worker.js public/app.js
