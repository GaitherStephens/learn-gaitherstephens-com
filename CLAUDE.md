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

## Two traps that cost real time on 2026-07-29

**The mount is not the truth.** Production was two builds ahead of `~/GaitherDyn/learn.gaitherstephens.com` because a parallel session deployed on 07-28 without pushing. Reading the mount, I concluded a feature (flag 72 session resume) had never been built and started rebuilding it; deploying that would have reverted a working feature. Before answering "is X implemented?", check the **live worker** (`curl the deployed app.js`) or a **fresh clone**, never the mount. Reconcile by rebasing onto the deployed file.

**Wrangler hangs when run from the mount.** `wrangler deploy` prints its banner and then never returns, apparently blocked on the `.wrangler` state directory, which the mount will not let it clear (deletes are denied from the sandbox). It is not a version or network problem: the API answers in 0.2s. Fix: copy `public/ src/ migrations/ wrangler.toml` to a scratch dir outside the mount and deploy from there.

## Theme and icons

Three themes, **system is the default**. `data-theme` on `<html>` is `"light"`, `"dark"`, or absent for system. Dark tokens are declared twice in `styles.css`, once under `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` and once under `:root[data-theme="dark"]`. That repetition is intentional: it is cheaper than adding a build step to a site that has none. An inline script in `<head>` sets the attribute before first paint so there is no white flash. The choice is stored in `localStorage` and also mirrored into synced `prefs` so a new device inherits it.

Icons are an inline SVG sprite in `index.html`, referenced with `<use href="#i-name">`.

- **Every `<use>` wrapper needs `viewBox="0 0 24 24"`.** Without it the sprite draws at 1:1 user units into a ~17px box and the icon appears cropped or blank.
- **The `icon()` helper takes the full sprite id** (`icon("i-cards")`), not a stem. It used to prepend `i-`, which produced `#i-i-cards` and every dynamic icon rendered empty with no console error.

## Motivation layer

Daily goal ring, streak, seven-day strip, resume card, session celebration, readiness score. Patterns borrowed from Duolingo/Khan/Udemy with the coercive parts deliberately left out: no points, no leaderboard, no lives, no loss aversion, no notifications.

Two rules worth preserving:

- The **streak counts a run ending today OR yesterday**, so an unfinished today never displays as broken. That display choice is the part of streak mechanics that makes people quit.
- **Readiness and mastery are deliberately pessimistic** (scaled down by coverage) and readiness is hidden below 15 questions. Never replace them with a fake predicted scaled score: Pearson does not publish the raw-to-scaled conversion, and inventing one would be lying to the person whose job depends on it.

Daily counters live in `state.days` keyed by **local** calendar day and merge by **max**, not by timestamp, so a phone day and a laptop day cannot erase each other.

`CRITIQUE-BRIEF.md` is a self-contained description of the design for external review.

## Mobile

She studies on her phone more than anything else. Verified at 390px: zero horizontal overflow, no tap target under 44px. Safe-area insets on the floating buttons, 16px minimum input text so iOS does not zoom on focus, hover styles suppressed under `@media (hover: none)`, static header in short landscape.

## The learner model (added after external critique)

The app used to know *what* she answered but not *why*, which made the adaptive engine blind: every wrong answer looked identical. Three additions fix that, and they are the point of the whole design now.

- **Confidence before reveal.** After picking an answer she taps how sure she was, then sees the result. Confident-and-wrong is surfaced explicitly and routed to a dedicated drill. This is the highest-value signal in the app for someone who failed by two questions, because it finds what she does not know she does not know. Toggleable in settings, default on.
- **Why-missed after wrong answers only.** Five options (never learned / mixed up / misread / forgot formula / changed answer). Skippable. The pattern drives the advice on the Last 50 page.
- **Rolling attempt log** in `state.recent`, capped at 300. Feeds accuracy, pace, calibration, trend, and competency mix.

`state.recent` merges by **union**, not last-write-wins: each attempt is a distinct event keyed on `at:qid`, so a sync cannot drop the attempts made on the other device. `state.days` still merges by max. Both rules are implemented twice, in `mergeState` (worker) and `pull` (client) — change one, change the other.

**Readiness is a band, never a number.** `Ready / Probably ready / Needs work / Far from ready / Not enough evidence`, always shown with the evidence behind it (questions answered, coverage, skills mastered, last full mock, trend). A percentage reads as precision the data does not support. It also refuses to report at all below 25 questions.

**Mastery decays.** `decayFactor()` is flat for 7 days then slides to a 0.7 floor over ~7 weeks. Without it, a competency drilled once in September still reads green in April, which is the most misleading thing a mastery display can do. Decay also feeds the adaptive drill weighting so stale areas resurface.

**Exam date drives everything.** `prefs.examDate` produces a countdown and a phase (`explore / build / sharpen / taper / final`), and the phase changes what the daily plan asks for, not just the wording. Without a date the app cannot pace anything, so the home screen asks for it.

**Teaching-topic hook.** She teaches this material daily, which no commercial prep product can exploit because it does not know the learner. Setting today's topic gives that competency a 4x weight in the adaptive drill. Stored per-day in `prefs.teaching`.

**Typed formula recall.** 49 cards carry `drill: "type"` and an `answers` array. The exam supplies no reference sheet, so formulas must be produced, not recognised. The grader normalises hard (case, whitespace, Greek letters spelled out, arrows, multiplication signs) and compares twice, exact and loose. A false "incorrect" on a right answer is the fastest way to make her abandon the drill, so tolerance beats strictness; there is also an "I actually had this right" override. Verified: all 49 cards accept every one of their own declared variants, and genuinely wrong answers like `d=v/m` are still rejected.

**Skill map.** All **101** published skills (not 92, which was an early miscount), marked mastered / shaky / untouched. Mastered requires at least two questions on that skill, all correct most recently. `build.py` fails if any skill has no question backing it, so the map can never quietly lie about coverage.

**Mini mocks.** 20 items at blueprint proportions on proportional time (37 min). Cheap enough to sit twice a week, which keeps the three full 80-item mocks in reserve.

## Study modes

Flashcards (Leitner, `BOXES` intervals in days), topic quiz, adaptive drill (weights competency by test share x mastery gap, interleaved), 80-question timed mock exam on the real blueprint, brain dump (free recall then self-scored checklist), concept guide (markdown rendered by the small renderer in `app.js`), missed queue, progress dashboard.

Mastery is accuracy scaled down until coverage of that competency passes 60 percent, so a short hot streak does not read as mastery.

## Content

252 practice questions, 300 flashcards, 68 guide sections, all original and mapped to the 92 official skills. Question counts per competency match the official blueprint exactly. Source JSON is assembled from the per-competency files; `content.json` is the built artifact.

Not a git repo yet. Intended home: `GaitherStephens/learn-gaitherstephens-com`.
