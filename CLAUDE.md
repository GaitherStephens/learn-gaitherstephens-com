# learn.gaitherstephens.com

Study app for the Florida FTCE **Middle Grades General Science 5–9 (004)** exam. Built for Meg (first-year middle school science teacher, Charlotte County). She sat the test once and finished about 7 scaled points short.

## The exam, per Pearson/FLDOE

80 multiple-choice questions, 2 hours 30 minutes, **scaled score of 200 to pass**, $150, no reference materials provided. Nine competencies with fixed weights (see `public/content.json` → `comps`). Pearson does not publish the raw-to-scaled conversion, so the app reports raw percent with a band rather than inventing a scaled score. Official source: https://www.fl.nesinc.com/testPage.asp?test=004 and the competency worksheet at `/Worksheets/FL004_FrameworkWorksheet.html`.

## Stack

Plain Cloudflare **Worker** (no framework) + static assets + D1. Deliberately not Astro: the whole app is four static files, and a plain Worker avoids an `npm install` in the disk-constrained sandbox.

- `src/worker.js` — PIN gate, HMAC-signed cookie, `/api/state` sync, asset passthrough
- `public/index.html`, `app.js`, `styles.css` — the SPA, vanilla JS, hash routing
- `public/content.json` — the entire question/flashcard/guide bank, ~480 KB
- D1 `learn-db` (`f1bf3d0a-a92e-4e1f-a2a8-fb02e62c494a`), migrations in `migrations/`

Deploy is **manual**: `wrangler deploy` from this directory. There is no CI; pushing alone ships nothing.

Repo: `GaitherStephens/learn-gaitherstephens-com`, deploy key at `../.gaither-private/id_ed25519_learn`. Push does **not** deploy; run `wrangler deploy` yourself.

## Auth

Same shape as house/recipes: **PIN + optional passkeys**.

- PIN is `1450` initially. The DB hash in `settings.learn_pin_sha256` wins; the `LEARN_PIN` secret is the fallback. Changing the PIN in the app writes the DB row, so it does not need a redeploy.
- Throttle: 6 attempts per 15 minutes per hashed IP, cleared on success. Fails **open** if the table is missing (deliberate: a broken table should not lock her out) but PIN checking fails **closed** if neither hash nor secret is set.
- Passkeys are the hand-rolled SubtleCrypto WebAuthn port from `recipes/src/lib/webauthn.ts`, reduced to a single user (no `user_id` column). Discoverable/resident key, UV required. Challenges are stateless HMAC-signed cookies with a secret that self-bootstraps into `settings`.
- Register one from Progress → Sign-in, after signing in with the PIN. `RP_ID`/`ORIGIN` in `src/webauthn.js` are hardcoded to this domain; they must match exactly or every assertion fails on rpId mismatch.

Secrets: `LEARN_PIN`, `SESSION_SECRET` (Worker secrets). Local copy in `../.gaither-private/learn-gaitherstephens.env`.

## Flags and back-to-top

Flag button bottom-left, back-to-top bottom-right, network convention. The flag posts **browser-direct** to `https://gaithernews.com/api/network-flag` and surfaces in admin.gaitherdyn.com.

`learn.gaitherstephens.com` had to be added to **both** `ALLOWED_ORIGINS` and `VALID_SITES` in `gaithernews/src/index.ts` (commit `0ab6a9e`). Those two lists are separate and a site missing from either fails silently, which is what ate Meg's recipes flag in June. Verified end to end: a real flag landed as `network_flags` id 68.

Back-to-top is driven by an **IntersectionObserver on `#topSentinel`** (a 400px marker pinned to the top of the document) plus a scroll listener plus an unconditional call at init. All three are needed: scroll events do not fire when the browser restores a scroll position or when a route render changes page height, and IntersectionObserver does not run in a tab the browser is not painting.

## Gotchas that already bit once

- **The login page's stylesheet must be reachable unauthenticated.** `PUBLIC_ASSETS` in `worker.js` allowlists `/styles.css` and `/favicon.ico` before the auth gate. Everything else, including `app.js` and `content.json`, stays gated. Without this the login page renders as raw unstyled HTML.
- **Run `./scripts/stamp.sh` before every deploy that touches `app.js`, `styles.css`, or `content.json`.** It rewrites the `?v=` build stamp everywhere at once. This bit the build three separate times: Chrome will serve a cached wrong-MIME stylesheet straight through a hard reload, and a stale `app.js` against a fresh worker produces bugs that look exactly like logic errors. The caching contract in `worker.js` is: HTML always revalidates (`no-cache`) because it carries the stamps, anything with `?v=` is `immutable`, anything else gets 5 minutes.
- **`scripts/stamp.sh` must never use `sed -i.bak`.** The `~/GaitherDyn` mount allows create and rename but DENIES deletes from the sandbox, so a `.bak` is undeletable, and one dropped in `public/` gets uploaded as a public asset.
- **Do not trust an automated browser tab for scroll or visibility testing.** Chrome does not paint background tabs, so `requestAnimationFrame`, `IntersectionObserver`, and programmatic `scrollTo` scroll events all silently do nothing there. Two "bugs" in the back-to-top button were this artifact, not real. Verify with a real input-driven scroll followed by a screenshot.
- **Explanations must never reference an answer by position.** The app shuffles the four choices on every presentation, so "Choice C is wrong because..." or "the first option reverses..." points at the wrong thing. Name distractors by their content. There is a regression gate for this; re-run it before any content change ships:

  ```
  python3 content-src/build.py
  ```

  `build.py` is the gate and it hard-fails on positional references. Always regenerate `public/content.json` through it rather than editing the built artifact by hand.

  Do **not** try to shortcut this with a case-insensitive grep. `grep -iE 'answers? +[A-D]'` matches the ordinary phrase "cannot answer a question", which produced a false failure once. The letter class has to stay case-sensitive.

## Progress sync

One shared account. All progress lives in a single `state` row as JSON, mirrored to `localStorage` so the app works offline.

Merge is **per-record last-write-wins**, not blob last-write-wins: each card/question/recall record carries an `at` timestamp and the newer one survives. Implemented identically in `mergeState` (worker) and `pull` (client), so a phone session and a laptop session cannot clobber each other. Exams are appended and de-duplicated on `at:raw:total`. If you change one merge implementation, change the other.

## Study modes

Flashcards (Leitner, `BOXES` intervals in days), topic quiz, adaptive drill (weights competency by test share x mastery gap, interleaved), 80-question timed mock exam on the real blueprint, brain dump (free recall then self-scored checklist), concept guide (markdown rendered by the small renderer in `app.js`), missed queue, progress dashboard.

Mastery is accuracy scaled down until coverage of that competency passes 60 percent, so a short hot streak does not read as mastery.

## Content

252 practice questions, 300 flashcards, 68 guide sections, all original and mapped to the 92 official skills. Question counts per competency match the official blueprint exactly. Source JSON is assembled from the per-competency files; `content.json` is the built artifact.

Not a git repo yet. Intended home: `GaitherStephens/learn-gaitherstephens-com`.
