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

Secrets: `LEARN_PIN`, `SESSION_SECRET` (Worker secrets). Local copy in `../.gaither-private/learn-gaitherstephens.env`. Auth **fails closed**: if `LEARN_PIN` is unset nobody gets in.

## Gotchas that already bit once

- **The login page's stylesheet must be reachable unauthenticated.** `PUBLIC_ASSETS` in `worker.js` allowlists `/styles.css` and `/favicon.ico` before the auth gate. Everything else, including `app.js` and `content.json`, stays gated. Without this the login page renders as raw unstyled HTML.
- **Bump the `?v=` on `/styles.css` in BOTH `worker.js` (login page) and `public/index.html` when styles change.** Chrome caches a wrong-MIME response hard, and `nosniff` then refuses to apply the sheet even after the server is fixed. A hard reload does not reliably clear it.
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
