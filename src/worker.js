// learn.gaitherstephens.com - FTCE Middle Grades General Science 5-9 study app.
// Plain Cloudflare Worker. Auth matches the house/recipes pattern: PIN gate with
// an attempt throttle, plus optional passkeys (WebAuthn). D1-backed cross-device
// progress sync. Static assets served from ./public via the ASSETS binding.

import {
  RP_ID, RP_NAME, issueChallenge, clearChallengeCookie, verifyRegistration,
  verifyAssertion, listCredentials, getCredential, saveCredential,
  deleteCredential, touchCredential, bytesToB64url,
} from "./webauthn.js";

const COOKIE = "learn_session";
const DEMO_COOKIE = "learn_demo";
const DEMO_HOURS = 6;
const SESSION_DAYS = 60;
const MAX_ATTEMPTS = 6;          // per window, per hashed IP
const ATTEMPT_WINDOW_MIN = 15;
const PIN_SETTING = "learn_pin_sha256";

/* ---------- crypto helpers ---------- */

const enc = new TextEncoder();

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return b64url(new Uint8Array(sig));
}

function sessionSecret(env) {
  // No hardcoded fallback. This used to end with || "learn-dev-secret",
  // a constant sitting in a public-shaped repo: with neither binding
  // configured, anyone who read this line could mint a valid session
  // token and walk straight past the login gate. SESSION_SECRET is set
  // in production today (checked with `wrangler secret list`), so the
  // fallback was never live, but a config slip would have downgraded
  // auth to a known secret SILENTLY instead of failing.
  //
  // Now it throws. mintSession and sessionValid are the only callers and
  // both sit behind try/catch at the router, so a missing secret means
  // nobody gets a session, which is the correct direction to fail.
  // The `|| env.LEARN_PIN` fallback is gone too (security review F5,
  // 2026-09-01). It was the same defect one layer down: signing sessions
  // with the LOGIN PIN means the signing key is a 4-digit number, and this
  // repository is public, so the token format is readable by anyone. One
  // observed cookie plus 10,000 offline guesses would have recovered the key
  // and allowed forged sessions indefinitely, with no way to revoke them
  // short of rotating the secret. A signing key must not be a credential a
  // human types.
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  return secret;
}

async function mintSession(env) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const payload = `1.${exp}`;
  return `${payload}.${await hmac(sessionSecret(env), payload)}`;
}

async function sessionValid(env, token) {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [v, exp, sig] = parts;
  if (v !== "1") return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || Date.now() > expNum) return false;
  return constantEqual(sig, await hmac(sessionSecret(env), `${v}.${exp}`));
}

function getCookie(req, name) {
  const raw = req.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

/* ---------- PIN ---------- */

// DB-stored hash wins (so the PIN can be changed in-app), env var is the
// fallback. Fails CLOSED: with neither configured, nobody gets in.
async function pinValid(env, attempted) {
  // Explicit PIN retirement (2026-09-01). Once Meg has added a passkey she can
  // turn the PIN off from /passkey; after that a stolen or guessed PIN is
  // worth nothing. Explicit rather than automatic, because learn has ONE user
  // and no second person to keep the door open: she disables it only when she
  // is confident her devices carry passkeys. Break-glass, if a device is lost:
  //   UPDATE settings SET value='0' WHERE key='pin_disabled';
  try {
    const off = await env.DB.prepare("SELECT value FROM settings WHERE key = 'pin_disabled'").first();
    if (off?.value === "1") return false;
  } catch { /* settings table may not exist yet: PIN stays enabled */ }
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(PIN_SETTING).first();
    if (row?.value) return constantEqual(await sha256Hex(attempted), row.value);
  } catch { /* settings table may not exist yet */ }
  if (env.LEARN_PIN) return constantEqual(await sha256Hex(attempted), await sha256Hex(env.LEARN_PIN));
  return false;
}

/* ---------- login throttle (fails CLOSED on DB error, review F10) ---------- */

async function throttled(env, ipHash) {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM login_attempts
       WHERE ip_hash = ? AND at > datetime('now', ?)`,
    ).bind(ipHash, `-${ATTEMPT_WINDOW_MIN} minutes`).first();
    return (row?.c ?? 0) >= MAX_ATTEMPTS;
  } catch {
    // Fail CLOSED: a read failure must not silently remove the brute-force
    // throttle. Treat an unreadable store as "throttled" so login refuses
    // rather than opening an unbounded guess loop. Break-glass if the table
    // is ever genuinely absent: it is recreated by the migration on deploy.
    return true;
  }
}

async function recordAttempt(env, ipHash) {
  try {
    await env.DB.prepare("INSERT INTO login_attempts (ip_hash, at) VALUES (?, datetime('now'))").bind(ipHash).run();
    await env.DB.prepare("DELETE FROM login_attempts WHERE at < datetime('now', '-1 day')").run();
  } catch { /* table may not exist yet */ }
}

async function clearAttempts(env, ipHash) {
  try {
    await env.DB.prepare("DELETE FROM login_attempts WHERE ip_hash = ?").bind(ipHash).run();
  } catch { /* noop */ }
}

/* ---------- progress state ---------- */

const EMPTY_STATE = { cards: {}, questions: {}, exams: [], recall: {}, days: {}, recent: [], prefs: {}, updatedAt: 0 };
const RECENT_CAP = 300;

async function loadState(env) {
  try {
    const row = await env.DB.prepare("SELECT data FROM state WHERE id = 1").first();
    if (row?.data) return { ...EMPTY_STATE, ...JSON.parse(row.data) };
  } catch { /* fall through */ }
  return { ...EMPTY_STATE };
}

async function saveState(env, state) {
  await env.DB.prepare(
    `INSERT INTO state (id, data, updated_at) VALUES (1, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).bind(JSON.stringify(state)).run();
}

// Per-record last-write-wins. Lets phone and laptop both make progress without
// one device's blob clobbering the other's.
function mergeRecords(mine, theirs) {
  const out = { ...mine };
  for (const [k, v] of Object.entries(theirs || {})) {
    const cur = out[k];
    if (!cur || (v?.at ?? 0) > (cur?.at ?? 0)) out[k] = v;
  }
  return out;
}

function mergeState(server, client) {
  const examKey = (e) => `${e.at}:${e.raw}:${e.total}`;
  const exams = [...(server.exams || [])];
  const seen = new Set(exams.map(examKey));
  for (const e of client.exams || []) if (!seen.has(examKey(e))) { exams.push(e); seen.add(examKey(e)); }
  exams.sort((a, b) => a.at - b.at);
  // Daily activity counters merge by MAX, not by timestamp. If she answers 10
  // questions on her phone and 5 on the laptop without syncing between, the
  // truthful-ish answer is 10, not whichever device wrote last. Undercounting
  // beats a device silently erasing the other's day.
  const days = { ...(server.days || {}) };
  for (const [d, v] of Object.entries(client.days || {})) {
    const cur = days[d] || {};
    days[d] = {
      q: Math.max(cur.q || 0, v.q || 0),
      c: Math.max(cur.c || 0, v.c || 0),
      at: Math.max(cur.at || 0, v.at || 0),
    };
  }

  // Rolling attempt log. Union rather than last-write-wins: every attempt is a
  // distinct event, and the "last 50" view is meaningless if a sync drops the
  // ones made on the other device. Keyed on time + question, which cannot
  // collide in practice.
  const seenAtt = new Set();
  const recent = [];
  for (const a of [...(server.recent || []), ...(client.recent || [])]) {
    const k = `${a.at}:${a.qid}`;
    if (seenAtt.has(k)) continue;
    seenAtt.add(k);
    recent.push(a);
  }
  recent.sort((a, b) => a.at - b.at);

  return {
    cards: mergeRecords(server.cards, client.cards),
    questions: mergeRecords(server.questions, client.questions),
    recall: mergeRecords(server.recall, client.recall),
    days,
    recent: recent.slice(-RECENT_CAP),
    exams: exams.slice(-200),
    prefs: (client.prefsAt ?? 0) >= (server.prefsAt ?? 0) ? (client.prefs || {}) : (server.prefs || {}),
    prefsAt: Math.max(client.prefsAt ?? 0, server.prefsAt ?? 0),
    updatedAt: Date.now(),
  };
}

/* ---------- responses ---------- */

const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=(), interest-cohort=()",
  // Network canonical string, exactly. Was "max-age=31536000;
  // includeSubDomains": one year and no preload, which does not match
  // SECURITY_BASELINE section 1 and would be rejected by the HSTS
  // preload list.
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  // Was absent entirely, which is why this site scored 6/7.
  "Cross-Origin-Opener-Policy": "same-origin",
  // CSP is still REPORT-ONLY, and here is the honest reason, because
  // "once a week or two passes clean" was written on 2026-07-31 and
  // four weeks went by.
  //
  // State as of 2026-08-25: the shared collector's last violation from
  // this host was 2026-08-16 (www.google.com/g/collect on connect-src,
  // and c.clarity.ms on img-src before that). BOTH origins are in the
  // policy below now and the last deploy was 08-19, so nothing has
  // reported since the current policy went live. The login page was
  // also loaded directly and produced zero report-only violations.
  //
  // What is NOT verified is the AUTHENTICATED app, which needs a login
  // to exercise and which no automated pass should be doing. Its
  // siblings stubbyz and fifthsense were promoted to enforcing on
  // 2026-08-25 after exactly this kind of check; this one waits until
  // someone opens the study app once and confirms the console is clean.
  // Flip it by deleting "-Report-Only" from the key below. 'unsafe-inline' is present
  // because the login page and the study app both use inline
  // script/style; tightening that is the follow-up, not a blocker.
  // (Re-landed 2026-07-31: this block was shipped 07-30 but lived only
  // as mount drift; a later deploy from repo HEAD dropped it. Now it is
  // in git where it cannot be lost. Includes the 07-31 #53 fix -
  // Cloudflare Web Analytics beacon - and the GA4/Clarity allowances
  // from the analytics rollout.)
  // PROMOTED TO ENFORCING 2026-09-01 (security review F18). Evidence: the
  // shared csp_violations collector shows ZERO learn violations since the
  // current policy went live 2026-08-19; the 12 earlier ones were all GA4
  // (www.google.com/g/collect), Clarity (c.clarity.ms), and the CF beacon,
  // every origin now allowlisted below. The AUTHENTICATED study app WAS
  // exercised under report-only (GA4 recorded scroll-to-90% + page_view
  // events titled "FTCE Science 5-9 Study"), so the earlier "waiting on a
  // real login" caveat is satisfied. A static scan found no external
  // resource beyond www.google.com; every client fetch is same-origin
  // /api/*, including the new /passkey page. report-uri stays on so any
  // regression is still reported. 'unsafe-inline' remains (inline
  // script/style); tightening it to hashes is the follow-up, not a blocker.
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://www.googletagmanager.com https://www.clarity.ms https://*.clarity.ms https://js.sentry-cdn.com https://browser.sentry-cdn.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.google-analytics.com https://*.googletagmanager.com https://*.clarity.ms https://c.clarity.ms",
    "font-src 'self' data:",
    // gaithernews.com = the network's RUM + flag + CSP-report collector.
    "connect-src 'self' https://gaithernews.com https://www.google.com https://cloudflareinsights.com https://*.cloudflareinsights.com https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://*.clarity.ms https://*.ingest.us.sentry.io https://*.ingest.sentry.io https://js.sentry-cdn.com",
    "object-src 'none'",
    "base-uri 'self'",
    // The login form posts to /login, same origin, so this is a
    // no-op for the app and closes off exfiltration to a third party.
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
    "report-uri https://gaithernews.com/api/csp-report",
  ].join("; "),
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SEC_HEADERS, ...extra },
  });
}

function safePath(p) {
  return /^\/[A-Za-z0-9/_-]*$/.test(p || "") ? p : "/";
}

function loginPage(error, nextPath) {
  const next = safePath(nextPath);
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark">
<title>Sign in : FTCE Science 5-9 Study</title>
<link rel="stylesheet" href="/styles.css?v=2026.08.17-1552">
<script>
if (!(typeof navigator !== "undefined" && navigator.globalPrivacyControl === true)) {
  window.sentryOnLoad = function () {
    Sentry.init({
      ignoreErrors: [
        "Invalid call to runtime.sendMessage",
        "Object Not Found Matching Id",
      ],
      denyUrls: [
        /clarity\\.js/i,
        /clarity\\.ms/i,
        /cloudflareinsights\\.com/i,
        /beacon\\.min\\.js/i,
        /googletagmanager\\.com/i,
      ],
    });
  };
  var __sentry = document.createElement("script");
  __sentry.src = "https://js.sentry-cdn.com/7be8f36d1e84f7d6960d0d6eb8e1a63c.min.js";
  __sentry.crossOrigin = "anonymous";
  document.head.appendChild(__sentry);
}
</script>
<script id="gd-flag-config" type="application/json">{"site":"learn.gaitherstephens.com","version":"2026-09-07_b31b532"}</script>
<link rel="stylesheet" href="/js/network-flag.css">
<script defer src="/js/network-flag.js"></script>
</head><body class="login-body">
<main class="login-card">
  <div class="login-mark">FTCE</div>
  <h1>Science 5&ndash;9 Study</h1>
  <p class="muted">Middle Grades General Science 5&ndash;9 (004)</p>
  ${error ? `<p class="login-error" role="alert">${error}</p>` : ""}
  <form method="POST" action="/login">
    <input type="hidden" name="next" value="${next}">
    <label for="pin">PIN</label>
    <input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" required autofocus>
    <button type="submit">Sign in</button>
  </form>
  <div class="passkey-wrap">
    <button type="button" id="passkeyBtn" hidden>Sign in with a passkey</button>
    <p class="login-error" id="passkeyErr" hidden></p>
  </div>

  <div class="demo-wrap">
    <span class="demo-or">or</span>
    <a class="demo-btn" href="/demo">Take a look around</a>
    <p class="demo-note">A full working demo with sample progress. Nothing you do is saved, and it cannot see anyone's real account.</p>
  </div>
</main>
<footer><p class="login-legal">An independent study tool. Not affiliated with, endorsed by, or connected to the Florida Department of Education or Pearson. FTCE is their trademark, used here only to say which exam this prepares for. All questions and explanations are original; no actual test items appear here.</p></footer>
<script>
(() => {
  const btn = document.getElementById("passkeyBtn");
  const perr = document.getElementById("passkeyErr");
  if (!btn || !window.PublicKeyCredential) return;
  btn.hidden = false;

  const b2b = (s) => {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  };
  const buf2b = (buf) => {
    const u = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
    return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  };
  const showErr = (m) => { perr.textContent = m; perr.hidden = false; };

  btn.addEventListener("click", async () => {
    perr.hidden = true;
    btn.disabled = true;
    try {
      const o = await (await fetch("/api/auth/passkey/login/options", { method: "POST" })).json();
      if (o.error) { showErr(o.error); return; }
      const cred = await navigator.credentials.get({
        publicKey: {
          challenge: b2b(o.challenge),
          rpId: o.rpId,
          userVerification: o.userVerification,
          timeout: o.timeout,
        },
      });
      const r = await fetch("/api/auth/passkey/login/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: cred.id,
          authenticatorData: buf2b(cred.response.authenticatorData),
          clientDataJSON: buf2b(cred.response.clientDataJSON),
          signature: buf2b(cred.response.signature),
          next: ${JSON.stringify(next)},
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { showErr(j.error || "Passkey sign-in failed."); return; }
      location.href = j.next || "/";
    } catch (e) {
      if (e && e.name === "NotAllowedError") showErr("Passkey prompt was dismissed.");
      else showErr("Passkey sign-in failed. Use the PIN instead.");
    } finally {
      btn.disabled = false;
    }
  });
})();
</script>
<p class="gd-flag-row" style="text-align:center;margin:18px 0 0;font-size:.85rem"><button type="button" data-gd-flag="open" class="gd-flag-trigger" style="background:none;border:0;color:inherit;text-decoration:underline;cursor:pointer;font:inherit">Report a problem with this page</button></p>
<script>
(function () {
  if (!("PerformanceObserver" in window) || !navigator.sendBeacon) return;
  var lcp = 0, cls = 0, worstEvt = 0, clsSeen = false;
  try {
    new PerformanceObserver(function (l) {
      var es = l.getEntries();
      if (es.length) lcp = es[es.length - 1].startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch (_) {}
  try {
    new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (e) { if (!e.hadRecentInput) { cls += e.value; } });
    }).observe({ type: "layout-shift", buffered: true });
    clsSeen = true;
  } catch (_) {}
  try {
    new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (e) { if (e.duration > worstEvt) worstEvt = e.duration; });
    }).observe({ type: "event", buffered: true, durationThreshold: 40 });
  } catch (_) {}
  var sent = false;
  function flush() {
    if (sent) return; sent = true;
    var nav = performance.getEntriesByType("navigation")[0];
    var m = {};
    if (lcp > 0) m.lcp = Math.round(lcp);
    if (clsSeen) m.cls = Math.round(cls * 1000) / 1000;
    if (worstEvt > 0) m.inp = Math.round(worstEvt);
    if (nav && nav.responseStart > 0) m.ttfb = Math.round(nav.responseStart);
    if (!Object.keys(m).length) return;
    navigator.sendBeacon("https://gaithernews.com/api/rum",
      new Blob([JSON.stringify({
        site: location.hostname,
        device: innerWidth < 768 ? "m" : "d",
        pg: location.pathname.split("/")[1] || "",
        metrics: m,
      })], { type: "text/plain" }));
  }
  addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flush();
  });
  addEventListener("pagehide", flush);
})();
</script>
</body></html>`;
}

/* ---------- worker ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // STD-43: the zone may not have Always Use HTTPS on; answer it here.
    if (url.protocol === "http:") return Response.redirect("https://" + url.host + url.pathname + url.search, 301);
    const path = url.pathname;
    const method = request.method;

    if (path === "/health") {
      return new Response("ok", { headers: { "Content-Type": "text/plain", ...SEC_HEADERS } });
    }

    /* --- ops: manual D1 -> R2 backup trigger (STD-22/STD-23) --- */
    // Same gate as house's /api/run-backup: OPS token only, timing-safe
    // compare, fails CLOSED if the secret is unset. Deliberately outside
    // the PIN session gate — this is an operator endpoint, not a user one,
    // and nothing here is readable without the token.
    if (path === "/run-backup" && method === "POST") {
      const expected = env.OPS_TOKEN;
      const given = request.headers.get("x-ops-token") || url.searchParams.get("token") || "";
      if (!expected || !constantEqual(given, expected)) {
        return new Response("unauthorized", { status: 401, headers: SEC_HEADERS });
      }
      try {
        const { runLearnBackup } = await import("./backup.js");
        const summary = await runLearnBackup(env);
        return new Response(summary + "\n", {
          headers: { "Content-Type": "text/plain; charset=utf-8", ...SEC_HEADERS },
        });
      } catch (e) {
        return new Response("backup failed: " + (e?.message || e), { status: 500, headers: SEC_HEADERS });
      }
    }

    // CSRF origin check (security review F11): state-changing requests must
    // come from our own page. The OPS-token /run-backup above already returned,
    // so it is exempt (machine endpoint, no browser Origin). learn serves no
    // CORS, so every legitimate non-safe request is a same-origin fetch that
    // carries Origin; a cross-site forgery does not. Fails closed when both
    // Origin and Referer are absent.
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const self = url.origin;
      const origin = request.headers.get("origin");
      const referer = request.headers.get("referer");
      const okOrigin = origin
        ? origin === self
        : referer ? referer === self || referer.startsWith(self + "/") : false;
      if (!okOrigin) return json({ error: "bad_origin" }, 403);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
    const ipHash = await sha256Hex(ip + "|" + sessionSecret(env));

    /* --- passkey login (public: these ARE the authentication) --- */

    if (path === "/api/auth/passkey/login/options" && method === "POST") {
      if (await throttled(env, ipHash)) return json({ error: "Too many attempts. Wait 15 minutes." }, 429);
      const creds = await listCredentials(env.DB);
      if (!creds.length) return json({ error: "No passkey is registered yet. Sign in with the PIN, then add one." }, 400);
      const { challenge, setCookie } = await issueChallenge(env.DB, "login");
      return json(
        { challenge, rpId: RP_ID, userVerification: "required", timeout: 60000 },
        200,
        { "Set-Cookie": setCookie },
      );
    }

    if (path === "/api/auth/passkey/login/verify" && method === "POST") {
      const clear = { "Set-Cookie": clearChallengeCookie() };
      if (await throttled(env, ipHash)) return json({ error: "Too many attempts. Wait 15 minutes." }, 429, clear);
      const body = await request.json().catch(() => ({}));
      if (!body.id || !body.authenticatorData || !body.clientDataJSON || !body.signature) {
        return json({ error: "missing fields" }, 400, clear);
      }
      const cred = await getCredential(env.DB, body.id);
      if (!cred) { await recordAttempt(env, ipHash); return json({ error: "unknown passkey" }, 401, clear); }
      const res = await verifyAssertion(env.DB, request, body, cred);
      if (!res.ok) { await recordAttempt(env, ipHash); return json({ error: res.reason || "verification failed" }, 401, clear); }

      await touchCredential(env.DB, cred.id);
      await clearAttempts(env, ipHash);
      const token = await mintSession(env);
      // Two Set-Cookie values (grant session, clear challenge) need two header
      // entries, so build Headers and append rather than using an object literal.
      const h = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store", ...SEC_HEADERS });
      h.append("Set-Cookie", sessionCookie(token));
      h.append("Set-Cookie", clearChallengeCookie());
      return new Response(
        JSON.stringify({ ok: true, next: safePath(String(body.next || "/")) }),
        { status: 200, headers: h },
      );
    }

    /* --- PIN login --- */

    if (path === "/login") {
      if (method === "POST") {
        if (await throttled(env, ipHash)) {
          return new Response(loginPage("Too many attempts. Wait 15 minutes and try again.", "/"), {
            status: 429, headers: { "Content-Type": "text/html; charset=utf-8", ...SEC_HEADERS },
          });
        }
        const form = await request.formData();
        const pin = String(form.get("pin") || "");
        const next = String(form.get("next") || "/");
        if (!(await pinValid(env, pin))) {
          await recordAttempt(env, ipHash);
          return new Response(loginPage("That PIN did not match. Try again.", next), {
            status: 401, headers: { "Content-Type": "text/html; charset=utf-8", ...SEC_HEADERS },
          });
        }
        await clearAttempts(env, ipHash);
        const token = await mintSession(env);
        return new Response(null, {
          status: 303,
          headers: { Location: safePath(next), "Set-Cookie": sessionCookie(token), ...SEC_HEADERS },
        });
      }
      return new Response(loginPage(null, url.searchParams.get("next") || "/"), {
        headers: { "Content-Type": "text/html; charset=utf-8", ...SEC_HEADERS },
      });
    }

    /* --- demo mode ---
       A read-only tour. It grants access to the app shell and the study
       content, but it never touches D1: the demo's progress lives only in
       that browser's localStorage and is thrown away. There is no path from
       a demo cookie to the real account's data. */
    if (path === "/demo") {
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/#/",
          "Set-Cookie": `${DEMO_COOKIE}=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DEMO_HOURS * 3600}`,
          ...SEC_HEADERS,
        },
      });
    }

    if (path === "/exit-demo") {
      return new Response(null, {
        status: 303,
        headers: { Location: "/login", "Set-Cookie": `${DEMO_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, ...SEC_HEADERS },
      });
    }

    if (path === "/logout") {
      return new Response(null, {
        status: 303,
        headers: { Location: "/login", "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, ...SEC_HEADERS },
      });
    }

    /* --- gate everything else --- */
    // The login page needs its own stylesheet before a session exists, so a tiny
    // allowlist of chrome-only assets is served unauthenticated. Study material
    // (app.js, content.json) is never in here.
    const PUBLIC_ASSETS = new Set(["/styles.css", "/favicon.ico", "/js/network-flag.js", "/js/network-flag.css"]);

    const authed = await sessionValid(env, getCookie(request, COOKIE));
    const isDemo = !authed && getCookie(request, DEMO_COOKIE) === "1";

    if (!authed && !isDemo && !PUBLIC_ASSETS.has(path)) {
      if (path.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
      return new Response(null, {
        status: 303,
        headers: { Location: `/login?next=${encodeURIComponent(path)}`, ...SEC_HEADERS },
      });
    }

    /* Demo callers get the app and the content, and nothing else. Every API
       that reads or writes the real account is answered here, before any of
       the handlers below can reach D1. Deny by default: only /api/state is
       given a synthetic response, everything else is refused outright. */
    if (isDemo && path.startsWith("/api/")) {
      // GET /api/state is the ONE thing a demo may call, and it returns a
      // synthetic empty state, never a D1 read. The client seeds its own demo
      // progress locally. Everything else, including any write, is refused.
      if (path === "/api/state" && method === "GET") {
        return json({ ...EMPTY_STATE, demo: true });
      }
      return json({ error: "not available in demo", demo: true }, 403);
    }

    /* --- passkey management (auth required) --- */

    // Passkey management page (session-gated by the auth check above).
    // learn had passkey LOGIN but no way to REGISTER one; this is that page.
    if (path === "/passkey" && method === "GET") {
      const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Passkeys · Learn</title>
<style>
  body{font:16px/1.55 system-ui,-apple-system,sans-serif;margin:0;background:#0f1419;color:#e8e6df}
  main{max-width:520px;margin:0 auto;padding:28px 20px}
  h1{font-size:1.4rem;margin:0 0 6px} .sub{color:#a8a59c;margin:0 0 22px}
  .card{border:1px solid #2a3138;border-radius:12px;padding:16px;margin:0 0 16px;background:#1a2129}
  button{font:inherit;padding:9px 16px;border-radius:9px;border:1px solid #3d454e;background:#01CCFF;color:#04222b;font-weight:600;cursor:pointer}
  button.ghost{background:transparent;color:#e8e6df}
  button:disabled{opacity:.5;cursor:not-allowed}
  .pk{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid #2a3138}
  .pk:first-child{border-top:0}
  .err{color:#e26b87;margin:8px 0 0} .ok{color:#7bd88f;margin:8px 0 0}
  .note{color:#a8a59c;font-size:.9rem;margin:10px 0 0} a{color:#01CCFF}
  .del{background:transparent;border-color:#e26b87;color:#e26b87;padding:4px 10px;font-size:.85rem}
</style></head><body><main>
  <h1>Passkeys</h1>
  <p class="sub">Sign in with Face ID, Touch ID, or your device unlock instead of the PIN.</p>
  <div class="card">
    <div id="list">Loading…</div>
    <div style="margin-top:12px"><button id="add">Add a passkey to this device</button></div>
    <p id="addMsg"></p>
    <p class="note">Add one on each device you use. A passkey lives on the device that made it, so a second one is what keeps you from being locked out if you lose this one.</p>
  </div>
  <div class="card">
    <h2 style="font-size:1.05rem;margin:0 0 4px">The PIN</h2>
    <p class="sub" id="pinState" style="margin:0 0 12px">…</p>
    <button id="pinToggle" class="ghost" disabled>…</button>
    <p id="pinMsg"></p>
  </div>
  <p class="note"><a href="/">← Back to studying</a></p>
<script>
(() => {
  const b2b=(x)=>{const b=x.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((x.length+3)%4);const s=atob(b);const u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u.buffer;};
  const buf2b=(b)=>{const u=new Uint8Array(b);let s="";for(let i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");};
  const $=(id)=>document.getElementById(id);
  let count=0, pinOff=false;
  async function refresh(){
    const r=await (await fetch("/api/auth/passkey")).json();
    const creds=r.credentials||[];
    count=creds.length;
    $("list").innerHTML = creds.length
      ? creds.map(function(c){var l=(c.label||"Passkey").replace(/[<>&]/g,"");return "<div class=\"pk\"><span>"+l+"</span><button class=\"del\" data-id=\""+c.id+"\">Remove</button></div>";}).join("")
      : "<p class='sub' style='margin:0'>No passkeys yet. Add one below.</p>";
    document.querySelectorAll(".del").forEach(b=>b.onclick=async()=>{
      if(!confirm("Remove this passkey?"))return;
      await fetch("/api/auth/passkey?id="+encodeURIComponent(b.dataset.id),{method:"DELETE"});
      refresh();
    });
    const ps=await (await fetch("/api/auth/pin-state")).json().catch(()=>({pin_disabled:false}));
    pinOff=!!ps.pin_disabled;
    $("pinState").textContent = pinOff
      ? "The PIN is turned off. You sign in with a passkey."
      : (count? "You can turn the PIN off now that you have a passkey." : "Add a passkey first, then you can turn the PIN off.");
    const t=$("pinToggle");
    t.textContent = pinOff ? "Turn the PIN back on" : "Turn the PIN off";
    t.disabled = !pinOff && count===0;
  }
  $("add").onclick=async()=>{
    $("addMsg").textContent=""; $("add").disabled=true;
    try{
      const o=await (await fetch("/api/auth/passkey/register/options",{method:"POST"})).json();
      if(o.error){$("addMsg").className="err";$("addMsg").textContent=o.error;return;}
      const cred=await navigator.credentials.create({publicKey:{
        challenge:b2b(o.challenge), rp:o.rp,
        user:{id:b2b(o.user.id), name:o.user.name, displayName:o.user.displayName},
        pubKeyCredParams:o.pubKeyCredParams,
        excludeCredentials:(o.excludeCredentials||[]).map(c=>({type:"public-key",id:b2b(c.id)})),
        authenticatorSelection:o.authenticatorSelection, timeout:o.timeout, attestation:o.attestation,
      }});
      const label = (navigator.platform||"This device").slice(0,40);
      const r=await fetch("/api/auth/passkey/register/verify",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({
          id:cred.id,
          clientDataJSON:buf2b(cred.response.clientDataJSON),
          publicKey:buf2b(cred.response.getPublicKey()),
          alg:cred.response.getPublicKeyAlgorithm(),
          label,
        })});
      const j=await r.json().catch(()=>({}));
      if(!r.ok){$("addMsg").className="err";$("addMsg").textContent=j.error||"Could not add the passkey.";return;}
      $("addMsg").className="ok";$("addMsg").textContent="Passkey added.";
      refresh();
    }catch(e){
      $("addMsg").className="err";
      $("addMsg").textContent = (e&&e.name==="NotAllowedError")?"Prompt dismissed.":"Could not add the passkey.";
    }finally{$("add").disabled=false;}
  };
  $("pinToggle").onclick=async()=>{
    $("pinMsg").textContent="";
    const disable=!pinOff;
    if(disable && !confirm("Turn the PIN off? You will sign in with a passkey. Make sure you have one on each device you use."))return;
    const r=await fetch("/api/auth/pin-toggle",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({disable})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok){$("pinMsg").className="err";$("pinMsg").textContent=j.error||"Could not change the PIN setting.";return;}
    refresh();
  };
  refresh();
})();
</script></main></body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", ...SEC_HEADERS } });
    }

    // Read-only PIN state for the /passkey page.
    if (path === "/api/auth/pin-state" && method === "GET") {
      let disabled = false;
      try {
        const row = await env.DB.prepare("SELECT value FROM settings WHERE key='pin_disabled'").first();
        disabled = row?.value === "1";
      } catch { /* default enabled */ }
      return json({ pin_disabled: disabled });
    }

    if (path === "/api/auth/passkey") {
      if (method === "GET") return json({ credentials: await listCredentials(env.DB) });
      if (method === "DELETE") {
        const id = url.searchParams.get("id");
        if (!id) return json({ error: "missing id" }, 400);
        return json({ ok: await deleteCredential(env.DB, id) });
      }
      return json({ error: "method not allowed" }, 405);
    }

    // Turn the PIN off / back on (session-gated, since it sits after the auth
    // gate above). Guarded: the PIN can only be DISABLED when at least one
    // passkey exists, so a click cannot lock the only user out with no way
    // back in. Re-enabling is always allowed.
    if (path === "/api/auth/pin-toggle" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const disable = body.disable === true;
      if (disable) {
        const creds = await listCredentials(env.DB);
        if (!creds.length) return json({ error: "Add a passkey before turning the PIN off." }, 400);
      }
      await env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES ('pin_disabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).bind(disable ? "1" : "0").run();
      return json({ ok: true, pin_disabled: disable });
    }

    if (path === "/api/auth/passkey/register/options" && method === "POST") {
      const { challenge, setCookie } = await issueChallenge(env.DB, "register");
      const existing = await listCredentials(env.DB);
      return json({
        challenge,
        rp: { id: RP_ID, name: RP_NAME },
        user: {
          id: bytesToB64url(new TextEncoder().encode("learn-user-1")),
          name: "meg",
          displayName: "Meg",
        },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        excludeCredentials: existing.map((c) => ({ type: "public-key", id: c.id })),
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        timeout: 60000,
        attestation: "none",
      }, 200, { "Set-Cookie": setCookie });
    }

    if (path === "/api/auth/passkey/register/verify" && method === "POST") {
      const clear = { "Set-Cookie": clearChallengeCookie() };
      const body = await request.json().catch(() => ({}));
      if (!body.id || !body.publicKey || typeof body.alg !== "number" || !body.clientDataJSON) {
        return json({ error: "missing fields" }, 400, clear);
      }
      const res = await verifyRegistration(env.DB, request, body);
      if (!res.ok) return json({ error: res.reason || "verification failed" }, 400, clear);
      await saveCredential(env.DB, {
        id: body.id,
        publicKey: body.publicKey,
        alg: body.alg,
        label: String(body.label || "Passkey").slice(0, 60),
      });
      return json({ ok: true }, 200, clear);
    }

    /* --- change PIN (auth required) --- */

    if (path === "/api/auth/pin" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const next = String(body.pin || "");
      if (!/^\d{4,12}$/.test(next)) return json({ error: "PIN must be 4 to 12 digits." }, 400);
      await env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).bind(PIN_SETTING, await sha256Hex(next)).run();
      return json({ ok: true });
    }

    /* --- progress state --- */

    if (path === "/api/state") {
      if (method === "GET") return json(await loadState(env));
      if (method === "POST") {
        let client;
        try { client = await request.json(); }
        catch { return json({ error: "bad json" }, 400); }
        const server = await loadState(env);
        const merged = mergeState(server, { ...EMPTY_STATE, ...client });
        await saveState(env, merged);
        return json(merged);
      }
      return json({ error: "method not allowed" }, 405);
    }

    if (path === "/api/reset" && method === "POST") {
      await saveState(env, { ...EMPTY_STATE, updatedAt: Date.now() });
      return json({ ok: true });
    }

    /* --- static assets --- */
    // Caching contract, learned the hard way three times in one build:
    // the HTML must ALWAYS revalidate, because it is what carries the ?v=
    // build stamp on every other asset. Anything that arrives WITH a ?v= is
    // immutable and can be cached hard. Anything without one gets a short TTL.
    // Bump the stamp in one place (scripts/stamp.sh) and everything refreshes.
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SEC_HEADERS)) out.headers.set(k, v);

    const isHtml = path === "/" || path.endsWith(".html") ||
      (out.headers.get("Content-Type") || "").startsWith("text/html");
    if (isHtml) {
      out.headers.set("Cache-Control", "no-cache");
      // Browser `no-cache` alone was not enough: Cloudflare's edge still
      // served a HIT, so a deploy could leave her on old HTML pointing at an
      // old app.js. CDN-Cache-Control is the edge-specific directive and
      // keeps the document out of the edge cache entirely.
      out.headers.set("CDN-Cache-Control", "no-store");
    }
    else if (url.searchParams.has("v")) out.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    else out.headers.set("Cache-Control", "public, max-age=300");
    return out;
  },

  // Weekly D1 -> R2 backup (Mon 09:00 UTC — clear of house's Mon 11/12 UTC
  // digest pair and gaithernews's Sun backup window). Resumable and
  // manifest-gated; see src/backup.js. STD-22/STD-23.
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const { runLearnBackup } = await import("./backup.js");
        console.log(await runLearnBackup(env));
      } catch (e) {
        console.error("learn backup FAILED:", e?.stack || e);
      }
    })());
  },
};
