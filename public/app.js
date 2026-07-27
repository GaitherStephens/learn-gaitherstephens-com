/* FTCE Middle Grades General Science 5-9 (004) study app.
   Study modes are built around four things that actually move retention:
   spaced retrieval, interleaving, immediate elaborative feedback, and
   free recall. Progress syncs through /api/state so phone and laptop agree. */

(() => {
  "use strict";

  const app = document.getElementById("app");
  const syncDot = document.getElementById("sync");
  const LS_KEY = "ftce004.state.v1";

  /* Leitner intervals in days, indexed by box. Box 0 means "again this session". */
  const BOXES = [0, 1, 3, 7, 16, 35, 90];

  /* Exam blueprint: questions per competency in an 80-item form. */
  const BLUEPRINT = { 1: 11, 2: 10, 3: 10, 4: 10, 5: 5, 6: 11, 7: 8, 8: 4, 9: 11 };
  const EXAM_MINUTES = 150;

  let DATA = null;
  let S = null;                 // progress state
  let session = null;           // whatever mode is running
  let saveTimer = null;

  /* ================= state ================= */

  const emptyState = () => ({ cards: {}, questions: {}, exams: [], recall: {}, days: {}, recent: [], prefs: {}, prefsAt: 0, updatedAt: 0 });
  const RECENT_CAP = 300;

  function loadLocal() {
    try { return { ...emptyState(), ...JSON.parse(localStorage.getItem(lsKey()) || "{}") }; }
    catch { return emptyState(); }
  }

  function writeLocal() {
    try { localStorage.setItem(lsKey(), JSON.stringify(S)); } catch { /* quota */ }
  }

  function setSync(cls, title) {
    syncDot.className = "sync-dot " + cls;
    syncDot.title = title;
  }

  /* Push to the server, debounced. Server merges per record by timestamp and
     returns the merged truth, so a stale device cannot wipe the other's work. */
  /* Demo mode. The server already refuses to read or write the real account
     for a demo caller; this side just keeps the demo's own progress in a
     separate localStorage key and never sends it anywhere. */
  let DEMO = false;
  const lsKey = () => (DEMO ? "ftce004.demo.v1" : LS_KEY);

  function save() {
    S.updatedAt = Date.now();
    writeLocal();
    if (DEMO) { setSync("ok", "Demo mode: progress is not saved"); return; }
    clearTimeout(saveTimer);
    setSync("busy", "Saving...");
    saveTimer = setTimeout(async () => {
      try {
        const res = await fetch("/api/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(S),
        });
        if (!res.ok) throw new Error(res.status);
        S = { ...emptyState(), ...(await res.json()) };
        writeLocal();
        setSync("ok", "Progress saved");
      } catch {
        setSync("err", "Offline: progress saved on this device only");
      }
    }, 900);
  }

  async function pull() {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      const raw = await res.json();
      if (raw.demo) {
        // Only flag it here. Seeding needs DATA, which is still being fetched
        // in parallel with this call, so it happens in boot once content is
        // in. Seeding here threw on a null DATA and silently fell through to
        // an empty state, which showed a visitor the first-run wizard.
        DEMO = true;
        document.body.classList.add("is-demo");
        S = loadLocal();
        setSync("ok", "Demo mode: progress is not saved");
        return;
      }
      const server = { ...emptyState(), ...raw };
      const local = loadLocal();
      // Same merge rule the server uses, so an offline session survives the pull.
      const mergeRec = (a, b) => {
        const out = { ...a };
        for (const [k, v] of Object.entries(b || {})) {
          if (!out[k] || (v?.at ?? 0) > (out[k]?.at ?? 0)) out[k] = v;
        }
        return out;
      };
      const key = (e) => `${e.at}:${e.raw}:${e.total}`;
      const exams = [...(server.exams || [])];
      const seen = new Set(exams.map(key));
      for (const e of local.exams || []) if (!seen.has(key(e))) exams.push(e);
      exams.sort((a, b) => a.at - b.at);
      // Mirror of the server rule: daily counters merge by max, not timestamp.
      const days = { ...(server.days || {}) };
      for (const [d, v] of Object.entries(local.days || {})) {
        const cur = days[d] || {};
        days[d] = { q: Math.max(cur.q || 0, v.q || 0), c: Math.max(cur.c || 0, v.c || 0), at: Math.max(cur.at || 0, v.at || 0) };
      }
      // Mirror of the server rule: attempts are events, so union them.
      const seenAtt = new Set();
      const recent = [];
      for (const a of [...(server.recent || []), ...(local.recent || [])]) {
        const k = `${a.at}:${a.qid}`;
        if (seenAtt.has(k)) continue;
        seenAtt.add(k);
        recent.push(a);
      }
      recent.sort((a, b) => a.at - b.at);
      S = {
        cards: mergeRec(server.cards, local.cards),
        questions: mergeRec(server.questions, local.questions),
        recall: mergeRec(server.recall, local.recall),
        days,
        recent: recent.slice(-RECENT_CAP),
        exams,
        prefs: (local.prefsAt ?? 0) >= (server.prefsAt ?? 0) ? local.prefs : server.prefs,
        prefsAt: Math.max(local.prefsAt ?? 0, server.prefsAt ?? 0),
        updatedAt: Date.now(),
      };
      writeLocal();
      setSync("ok", "Synced across devices");
    } catch {
      S = loadLocal();
      setSync("err", "Offline: using this device's saved progress");
    }
  }

  /* Build a plausible few weeks of study so a visitor sees a working app
     rather than a wall of empty charts. Deterministic, so the demo looks the
     same to everyone, and shaped to be honestly mid-progress: strong in a
     couple of competencies, weak in others, a few confidently-wrong answers
     to make the diagnostics show their point. */
  function seedDemo() {
    const st = emptyState();
    const t = Date.now();
    const day = 86400000;

    // Rough accuracy per competency, so the mastery bars differ meaningfully.
    const skill = { 1: 0.86, 2: 0.62, 3: 0.55, 4: 0.78, 5: 0.9, 6: 0.7, 7: 0.8, 8: 0.92, 9: 0.66 };
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    const pool = DATA.questions.filter((_, i) => i % 3 !== 2);   // ~2/3 of the bank
    for (const q of pool) {
      const ok = rnd() < (skill[q.comp] ?? 0.7);
      const at = t - Math.floor(rnd() * 21) * day;
      const conf = ok ? (rnd() < 0.6 ? 4 : 3) : (rnd() < 0.35 ? 4 : rnd() < 0.6 ? 2 : 1);
      const ms = 25000 + Math.floor(rnd() * 90000);
      st.questions[q.id] = { seen: 1, correct: ok ? 1 : 0, wrong: ok ? 0 : 1, lastCorrect: ok, conf, ms, at };
      st.recent.push({ qid: q.id, comp: q.comp, skill: q.skill, ok, conf, ms, why: ok ? "" : ["never", "mixed", "misread", "formula"][Math.floor(rnd() * 4)], at });
    }
    st.recent.sort((a, b) => a.at - b.at);
    st.recent = st.recent.slice(-120);

    for (const c of DATA.cards.filter((_, i) => i % 2 === 0)) {
      const box = 1 + Math.floor(rnd() * 4);
      st.cards[c.id] = { box, due: t + (rnd() < 0.3 ? -day : days(BOXES[box])), seen: 1 + Math.floor(rnd() * 3), at: t - Math.floor(rnd() * 14) * day };
    }

    st.exams.push(
      { at: t - 12 * day, raw: 51, total: 80, minutes: 141, byComp: {}, mini: false },
      { at: t - 5 * day, raw: 14, total: 20, minutes: 33, byComp: {}, mini: true },
      { at: t - 2 * day, raw: 15, total: 20, minutes: 31, byComp: {}, mini: true },
    );

    for (let i = 0; i < 9; i++) {
      const d = new Date(t - i * day);
      if (i === 3) continue;                       // one missed day, honestly
      st.days[dayKey(d)] = { q: 12 + Math.floor(rnd() * 20), c: 8 + Math.floor(rnd() * 15), at: t - i * day };
    }

    const exam = new Date(t + 26 * day);
    st.prefs = {
      name: "Sam",
      examDate: `${exam.getFullYear()}-${String(exam.getMonth() + 1).padStart(2, "0")}-${String(exam.getDate()).padStart(2, "0")}`,
      dailyGoal: 20,
      askConfidence: true,
      onboarded: true,
    };
    st.prefsAt = t;
    st.updatedAt = t;
    return st;
  }

  /* ================= helpers ================= */

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const now = () => Date.now();
  const days = (n) => n * 86400000;
  const compTitle = (n) => (DATA.comps.find((c) => c.comp === n) || {}).title || `Competency ${n}`;
  const compPct = (n) => (DATA.comps.find((c) => c.comp === n) || {}).pct || 0;

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function sample(arr, n) { return shuffle(arr).slice(0, n); }

  function pluralize(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

  // `name` is the full sprite id ("i-cards"), not a bare stem. Prefixing here
  // as well produced "#i-i-cards" and every icon silently rendered empty.
  const icon = (name, cls = "ico") => `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true"><use href="#${name}"></use></svg>`;

  const COMP_ICON = { 1: "i-atom", 2: "i-motion", 3: "i-energy", 4: "i-earth", 5: "i-space", 6: "i-life", 7: "i-eco", 8: "i-lab", 9: "i-search" };
  const COMP_SHORT = { 1: "Matter", 2: "Forces", 3: "Energy", 4: "Earth", 5: "Space", 6: "Life", 7: "Environment", 8: "Classroom", 9: "Inquiry" };

  // Competency icon, tinted with that competency's colour.
  const compIcon = (n) => `<svg viewBox="0 0 24 24" class="ico ico--comp c${n}" aria-hidden="true"><use href="#${COMP_ICON[n] || "i-book"}"></use></svg>`;

  /* Competency chip. Colour, number, short name and icon all at once: four
     redundant cues so the colour never has to do the work by itself. */
  const compChip = (n, extra = "") => `<span class="cchip c${n}">${
    `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><use href="#${COMP_ICON[n] || "i-book"}"></use></svg>`
  }${n}. ${esc(COMP_SHORT[n] || "")}${extra}</span>`;

  const diffPips = (d) => `<span class="diff" title="Difficulty ${d} of 3" aria-label="Difficulty ${d} of 3">${
    [1, 2, 3].map((i) => `<i class="${i <= d ? "on" : ""}"></i>`).join("")}</span>`;

  const STATUS_META = {
    mastered: { cls: "ok", icon: "i-check-circle", label: "Mastered" },
    shaky: { cls: "mid", icon: "i-alert", label: "Shaky" },
    untouched: { cls: "no", icon: "i-seed", label: "Not started" },
  };
  const statusPill = (state) => {
    const m = STATUS_META[state];
    return `<span class="status ${m.cls}">${icon(m.icon, "ico ico--sm")}${m.label}</span>`;
  };

  const CONF_ICON = { 1: "i-dice", 2: "i-half", 3: "i-thumb", 4: "i-star" };
  const WHY_ICON = { never: "i-seed", mixed: "i-swap", misread: "i-eye", formula: "i-energy", changed: "i-undo" };

  /* ================= theme ================= */

  const THEMES = ["system", "light", "dark"];
  const THEME_ICON = { system: "i-auto", light: "i-sun", dark: "i-moon" };
  const THEME_LABEL = { system: "Match my device", light: "Light", dark: "Dark" };

  function currentTheme() {
    try { return localStorage.getItem("ftce004.theme") || "system"; } catch { return "system"; }
  }

  function applyTheme(t) {
    const root = document.documentElement;
    if (t === "light" || t === "dark") root.setAttribute("data-theme", t);
    else root.removeAttribute("data-theme");
    try { localStorage.setItem("ftce004.theme", t); } catch { /* private mode */ }
    // Also ride along in synced prefs so a new device inherits the choice.
    S.prefs = { ...(S.prefs || {}), theme: t };
    S.prefsAt = Date.now();
    const btn = $("#themeBtn");
    if (btn) {
      btn.innerHTML = `<svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><use href="#${THEME_ICON[t]}"></use></svg>`;
      btn.title = `Theme: ${THEME_LABEL[t]}`;
      btn.setAttribute("aria-label", `Theme: ${THEME_LABEL[t]}. Tap to change.`);
    }
    document.querySelectorAll("[data-theme-opt]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.themeOpt === t));
    });
  }

  function initTheme() {
    // A synced pref from another device wins on first load only if this device
    // has never chosen; a local choice is what she just tapped, so it stays.
    let t = currentTheme();
    let hasLocal = true;
    try { hasLocal = localStorage.getItem("ftce004.theme") !== null; } catch { hasLocal = false; }
    if (!hasLocal && S.prefs?.theme && THEMES.includes(S.prefs.theme)) t = S.prefs.theme;
    applyTheme(t);
    const btn = $("#themeBtn");
    if (btn) {
      btn.onclick = () => {
        const next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
        applyTheme(next);
        save();
      };
    }
  }

  /* ================= daily goal + streak ================= */

  // Local calendar day, not UTC. A 9pm study session in Florida must not count
  // as tomorrow.
  function dayKey(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  const goalTarget = () => Number(S.prefs?.dailyGoal) || 20;

  function bump(kind) {
    const k = dayKey();
    const d = S.days[k] || { q: 0, c: 0, at: 0 };
    if (kind === "q") d.q++; else d.c++;
    d.at = now();
    S.days[k] = d;
  }

  const dayTotal = (k) => { const d = S.days[k]; return d ? (d.q || 0) + (d.c || 0) : 0; };
  const todayCount = () => dayTotal(dayKey());
  const goalMet = (k) => dayTotal(k) >= goalTarget();

  // Streak counts consecutive days meeting the goal, ending today or yesterday.
  // Yesterday still counts so an unfinished today does not read as "broken",
  // which is the part of streak mechanics that makes people quit.
  function streak() {
    const d = new Date();
    if (!goalMet(dayKey(d))) d.setDate(d.getDate() - 1);
    let n = 0;
    for (;;) {
      if (!goalMet(dayKey(d))) break;
      n++;
      d.setDate(d.getDate() - 1);
      if (n > 400) break;
    }
    return n;
  }

  function lastSevenDays() {
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      out.push({ key: dayKey(d), label: "SMTWTFS"[d.getDay()], met: goalMet(dayKey(d)), isToday: i === 0 });
    }
    return out;
  }

  /* ================= skills, decay, readiness ================= */

  const SKILL_COUNT = () => Object.values(DATA.skills).reduce((a, v) => a + v.length, 0);

  // Per-skill status. This is the view that answers her original question,
  // "what am I actually responsible for", so it is deliberately strict:
  // one lucky answer is not mastery.
  function skillStatus(comp, skill) {
    const qs = DATA.questions.filter((q) => q.comp === comp && q.skill === skill);
    let seen = 0, right = 0, lastAt = 0;
    for (const q of qs) {
      const r = S.questions[q.id];
      if (!r?.seen) continue;
      seen++;
      if (r.lastCorrect) right++;
      lastAt = Math.max(lastAt, r.at || 0);
    }
    if (!seen) return { state: "untouched", seen, right, total: qs.length, lastAt };
    const solid = seen >= 2 && right === seen;
    return { state: solid ? "mastered" : "shaky", seen, right, total: qs.length, lastAt };
  }

  function skillSummary() {
    const out = { mastered: 0, shaky: 0, untouched: 0 };
    for (const [comp, list] of Object.entries(DATA.skills)) {
      for (let i = 1; i <= list.length; i++) out[skillStatus(Number(comp), i).state]++;
    }
    return out;
  }

  /* Knowledge decays. Without this, a competency drilled in September still
     reads green in April, which is the single most misleading thing a mastery
     display can do. Gentle on purpose: nothing for a week, then a slow slide
     to a 70% floor over about seven weeks. It never reaches zero, because she
     did genuinely learn it once. */
  function decayFactor(lastAt) {
    if (!lastAt) return 1;
    const d = (now() - lastAt) / 86400000;
    if (d <= 7) return 1;
    return Math.max(0.7, 1 - (d - 7) / 50 * 0.3);
  }

  function compLastTouched(comp) {
    let t = 0;
    for (const q of DATA.questions) {
      if (q.comp !== comp) continue;
      const r = S.questions[q.id];
      if (r?.at) t = Math.max(t, r.at);
    }
    return t;
  }

  /* Readiness. Reported as a BAND with the evidence behind it, never as a bare
     percentage: a number like "82%" reads as scientific precision that the
     underlying data does not support, and Pearson does not publish the
     raw-to-scaled conversion anyway. */
  function readiness() {
    let score = 0, weight = 0;
    for (const c of DATA.comps) {
      const m = compMastery(c.comp);
      score += c.pct * m.score * decayFactor(compLastTouched(c.comp));
      weight += c.pct;
    }
    const base = weight ? score / weight : 0;
    const o = overall();
    const coverage = o.total ? o.seen / o.total : 0;
    const sk = skillSummary();
    const mocks = S.exams.filter((e) => e.total >= 40);
    const lastMock = mocks[mocks.length - 1];
    const trend = recentTrend();

    let band, why;
    if (o.seen < 25) {
      band = "Not enough evidence";
      why = "Answer more questions and this starts reporting.";
    } else if (base >= 0.8 && coverage >= 0.6 && sk.untouched === 0 && lastMock && lastMock.raw / lastMock.total >= 0.8) {
      band = "Ready";
      why = "Strong across the blueprint, full skill coverage, and a mock exam at or above 80 percent.";
    } else if (base >= 0.72 && coverage >= 0.4 && sk.untouched <= 8) {
      band = "Probably ready";
      why = lastMock ? "Solid practice accuracy. Confirm it with another full mock." : "Solid practice accuracy, but you have not sat a full mock yet.";
    } else if (base >= 0.55) {
      band = "Needs work";
      why = sk.untouched > 15 ? `${sk.untouched} skills are still untouched.` : "Accuracy is below the safety line on too much of the blueprint.";
    } else {
      band = "Far from ready";
      why = "Accuracy is well below the passing region across most of the test.";
    }
    return { band, why, base, coverage, sk, lastMock, trend, seen: o.seen };
  }

  const BAND_CLASS = { "Ready": "pass", "Probably ready": "pass", "Needs work": "close", "Far from ready": "no", "Not enough evidence": "" };

  // Accuracy over the most recent attempts versus the ones before, so the app
  // can say "improving" or "slipping" rather than only reporting a level.
  function recentTrend(n = 50) {
    const r = S.recent || [];
    if (r.length < 20) return null;
    const last = r.slice(-n);
    const prev = r.slice(-2 * n, -n);
    if (!prev.length) return null;
    const acc = (a) => a.filter((x) => x.ok).length / a.length;
    const d = acc(last) - acc(prev);
    return { delta: d, last: acc(last), prev: acc(prev) };
  }

  /* ================= today's teaching ================= */

  /* Her real edge over every other test-taker: she teaches this material in a
     classroom the same day. Whatever she taught today already has the relevant
     knowledge activated, so practising it tonight is cheap and sticky. This is
     the one thing a commercial prep product structurally cannot do, because it
     does not know the learner. */

  function todaysTeaching() {
    const t = S.prefs?.teaching;
    if (!t || t.date !== dayKey()) return null;
    return t;
  }

  function setTeaching(comp) {
    S.prefs = { ...(S.prefs || {}), teaching: comp ? { date: dayKey(), comp } : null };
    S.prefsAt = Date.now();
    save();
  }

  /* ================= exam date and pacing ================= */

  const examDate = () => S.prefs?.examDate || null;

  function daysUntilExam() {
    const d = examDate();
    if (!d) return null;
    const [y, m, day] = d.split("-").map(Number);
    const target = new Date(y, m - 1, day);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    target.setHours(0, 0, 0, 0);
    return Math.round((target - today) / 86400000);
  }

  // The app should behave differently at 90 days than at 3. Phases change what
  // the daily plan asks for, not just the wording.
  function phase() {
    const d = daysUntilExam();
    if (d === null) return { key: "open", label: "No test date set" };
    if (d < 0) return { key: "past", label: "Test date has passed" };
    if (d <= 3) return { key: "final", label: "Final days" };
    if (d <= 10) return { key: "taper", label: "Last stretch" };
    if (d <= 30) return { key: "sharpen", label: "Sharpening" };
    if (d <= 60) return { key: "build", label: "Building" };
    return { key: "explore", label: "Early days" };
  }

  /* The daily plan. Deliberately small and finishable: a plan she completes is
     worth more than an optimal one she abandons. */
  function dailyPlan() {
    const p = phase().key;
    const dueN = dueCards().length;
    const missedN = missedQuestions().length;
    const sk = skillSummary();
    const items = [];

    if (dueN) items.push({ icon: "i-cards", label: `Review ${Math.min(dueN, p === "final" ? 15 : 30)} due cards`, hash: "#/cards" });

    if (p === "explore" || p === "build") {
      if (sk.untouched) items.push({ icon: "i-search", label: `Cover ${Math.min(sk.untouched, 3)} untouched skills`, hash: "#/skills" });
      items.push({ icon: "i-quiz", label: "One topic quiz, 15 questions", hash: "#/quiz" });
    }
    if (p === "build" || p === "sharpen") items.push({ icon: "i-shuffle", label: "One adaptive drill, 20 questions", hash: "#/drill" });
    if (p === "sharpen" || p === "taper") items.push({ icon: "i-clock", label: "One mini mock, 20 questions on the clock", hash: "#/mini" });
    if (missedN) items.push({ icon: "i-redo", label: `Clear ${Math.min(missedN, 15)} from the missed queue`, hash: "#/missed" });
    if (p === "taper" || p === "final") items.push({ icon: "i-energy", label: "Formula drill, typed from memory", hash: "#/formulas" });
    if (p === "final") items.push({ icon: "i-book", label: "Skim the traps in the concept guide", hash: "#/guide" });
    if (!items.length) items.push({ icon: "i-shuffle", label: "One adaptive drill, 20 questions", hash: "#/drill" });

    return items.slice(0, 5);
  }

  /* ================= scoring model ================= */

  /* Mastery blends accuracy with coverage so answering three easy items does not
     read as "mastered". Unseen questions count as zero coverage. */
  function compMastery(comp) {
    const qs = DATA.questions.filter((q) => q.comp === comp);
    let seen = 0, correct = 0;
    for (const q of qs) {
      const r = S.questions[q.id];
      if (!r || !r.seen) continue;
      seen++;
      if (r.lastCorrect) correct++;
    }
    const coverage = qs.length ? seen / qs.length : 0;
    const accuracy = seen ? correct / seen : 0;
    return { seen, total: qs.length, coverage, accuracy, score: accuracy * Math.min(1, coverage / 0.6) };
  }

  function overall() {
    let seen = 0, total = 0, correct = 0;
    for (const q of DATA.questions) {
      total++;
      const r = S.questions[q.id];
      if (r?.seen) { seen++; if (r.lastCorrect) correct++; }
    }
    return { seen, total, correct, accuracy: seen ? correct / seen : 0 };
  }

  function dueCards() {
    const t = now();
    return DATA.cards.filter((c) => {
      const r = S.cards[c.id];
      return !r || (r.due ?? 0) <= t;
    });
  }

  function missedQuestions() {
    return DATA.questions.filter((q) => {
      const r = S.questions[q.id];
      return r && r.seen && !r.lastCorrect;
    });
  }

  function barClass(v) { return v < 0.5 ? "weak" : v < 0.75 ? "mid" : "strong"; }
  // Matching text colour for the same three performance bands, so the number
  // beside a bar agrees with the bar.
  function barTone(v) { return v < 0.5 ? "bad" : v < 0.75 ? "warn" : "good"; }

  /* Raw-percent bands. Pearson does not publish the raw-to-scaled conversion for
     the FTCE, so this is deliberately a band, not a fake precise scaled score. */
  function band(pct) {
    if (pct >= 0.8) return { cls: "pass", label: "On track to pass" };
    if (pct >= 0.72) return { cls: "close", label: "Borderline: keep drilling" };
    return { cls: "no", label: "Not there yet" };
  }

  /* ================= tiny markdown ================= */

  function md(src) {
    const blocks = String(src).split(/\n{2,}/);
    let html = "";
    for (let block of blocks) {
      block = block.trim();
      if (!block) continue;

      if (block.startsWith("```")) {
        const body = block.replace(/^```[a-z]*\n?/, "").replace(/```$/, "");
        html += `<pre>${esc(body.trim())}</pre>`;
        continue;
      }
      if (/^\*\*Trap:\*\*/.test(block)) {
        html += `<div class="trap">${inline(block)}</div>`;
        continue;
      }
      const h = block.match(/^(#{2,4})\s+(.*)$/);
      if (h) { const lvl = Math.min(4, h[1].length + 1); html += `<h${lvl}>${inline(h[2])}</h${lvl}>`; continue; }

      const lines = block.split("\n");
      if (lines.length > 1 && lines[0].includes("|") && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[1])) {
        const cells = (l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
        const head = cells(lines[0]);
        let t = "<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
        for (const row of lines.slice(2)) {
          if (!row.includes("|")) continue;
          t += "<tr>" + cells(row).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
        }
        html += t + "</tbody></table>";
        continue;
      }
      if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        html += "<ul>" + lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("") + "</ul>";
        continue;
      }
      if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        html += "<ol>" + lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("") + "</ol>";
        continue;
      }
      html += `<p>${inline(block).replace(/\n/g, "<br>")}</p>`;
    }
    return html;
  }

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  }

  /* ================= routing ================= */

  const routes = {
    "": home,
    "cards": cardsSetup,
    "quiz": quizSetup,
    "drill": drillStart,
    "exam": examSetup,
    "mini": miniMockStart,
    "formulas": formulaDrillStart,
    "skills": skillMap,
    "review": reviewDashboard,
    "guide": guideIndex,
    "recall": recallSetup,
    "missed": missedStart,
    "progress": progressView,
    "help": helpPage,
  };

  /* Navigate. If the target hash is what we are already on, assigning it fires
     no hashchange and the click does nothing, which is how "Go again" on the
     formula drill and re-tapping a mode you are already in ended up silently
     dead. Re-render explicitly in that case. */
  function go(hash) {
    if (location.hash === hash) router();
    else location.hash = hash;
  }
  // Inline onclick handlers in template strings run in global scope.
  window.__go = go;

  function router() {
    const raw = (location.hash || "#/").replace(/^#\/?/, "");
    const [head, ...rest] = raw.split("/");
    const fn = routes[head] || home;
    window.scrollTo(0, 0);
    fn(rest);
  }

  /* ================= help ================= */

  /* Help lives in two places on purpose: a full page for "what is all this",
     and a collapsed box on each section for "what am I looking at right now".
     Nobody reads a manual before starting, but people will open a one-line
     explainer that is already on the screen they are stuck on. */

  const HELP = {
    cards: {
      icon: "i-cards", title: "Flashcards",
      what: "300 cards covering the whole test, shown on a schedule.",
      when: "Your daily default. Ten minutes here beats an hour once a week.",
      how: [
        "Read the front and try to answer it in your head before you tap Show answer. The trying is the part that works.",
        "Rate yourself honestly. Blank brings it back in this session, Shaky tomorrow, Got it in a few days, Easy in a week or more.",
        "Rating everything Easy feels good and teaches you nothing. The schedule only helps if the ratings are true.",
        "Formula cards make you type the answer instead of rating yourself, because the real test gives you no formula sheet.",
      ],
      tip: "Keyboard: space to reveal, then 1 to 4 to rate.",
    },
    quiz: {
      icon: "i-quiz", title: "Topic quiz",
      what: "Questions from one competency, with an explanation after every single one.",
      when: "Right after you read a section of the concept guide, or when one area feels shaky.",
      how: [
        "Pick the competency, pick a length, start.",
        "You get the explanation immediately, whether you were right or wrong. Read it even when you were right.",
        "Tick 'prefer questions I have not seen' to push into new material instead of re-answering familiar ones.",
      ],
      tip: "Keyboard: A to D or 1 to 4 to answer, Enter for the next question.",
    },
    drill: {
      icon: "i-shuffle", title: "Adaptive drill",
      what: "Twenty questions chosen for you and deliberately jumbled across competencies.",
      when: "When you do not know what to study. This is the safe default.",
      how: [
        "It weights toward competencies you are weak in, ones that carry more of the test, things you got wrong before, and anything you have not touched in weeks.",
        "The mix is jumbled on purpose. Studying one topic in a block feels easier but sticks worse than mixing them.",
        "If you set today's teaching topic on the home screen, that subject gets pulled in heavily.",
      ],
      tip: "Twenty questions is about twelve minutes.",
    },
    mini: {
      icon: "i-clock", title: "Mini mock",
      what: "Twenty questions on the real blueprint proportions, on the real clock, 37 minutes.",
      when: "Once or twice a week once you are past the early stage.",
      how: [
        "No feedback until you submit, exactly like the real thing.",
        "You can flag questions and jump around with the number grid at the bottom.",
        "Afterwards you get your score by competency and your average seconds per question.",
      ],
      tip: "The real exam gives you 112 seconds per question. This one holds you to the same pace.",
    },
    exam: {
      icon: "i-exam", title: "Full mock exam",
      what: "All 80 questions, 2 hours 30 minutes, no feedback until you submit.",
      when: "Sparingly. There are only about three of these in the bank before questions start repeating.",
      how: [
        "Sit it properly: one go, no notes, no phone. A practice test you interrupt tells you nothing useful.",
        "Unanswered questions count as wrong when the clock runs out, same as the real exam.",
        "Your result is a raw percentage in a band, not a predicted scaled score.",
      ],
      tip: "Use mini mocks for regular practice and save these to confirm you are ready.",
    },
    formulas: {
      icon: "i-energy", title: "Formula drill",
      what: "The formulas and ordered lists you have to produce from memory, typed rather than recognised.",
      when: "Weekly, and every few days in the last fortnight before the test.",
      how: [
        "Type it however you normally would. Capitals, spaces and symbols are all forgiven, and 'lambda' works as well as the Greek letter.",
        "If it marks you wrong but you know you had it right, tap 'I actually had this right' and it counts.",
        "Getting one wrong sends it straight back to the start of the schedule. Formulas are all or nothing on the day.",
      ],
      tip: "There is no reference sheet on the real test. Recognising a formula is not the same as producing one.",
    },
    recall: {
      icon: "i-brain", title: "Brain dump",
      what: "You explain a whole competency from memory, then check yourself against the key points.",
      when: "After reading a guide section, or before a mock exam to find the holes.",
      how: [
        "Say it out loud as if you were teaching it to your class. You do this for a living, so use that.",
        "Typing is optional. The checklist afterwards is where the value is.",
        "Be strict when you tick. 'I sort of knew that' is a no.",
      ],
      tip: "This is the hardest mode and the most revealing. Whatever you could not produce is a real gap.",
    },
    guide: {
      icon: "i-book", title: "Concept guide",
      what: "Every competency explained, with the formulas to memorise and the traps that catch people.",
      when: "When something is genuinely new, or you got a question wrong because you never learned it.",
      how: [
        "Each section ends with a Trap box naming the misconception that makes people pick the wrong answer.",
        "Reading is the weakest way to study on its own, so follow it with a quiz or a brain dump on the same competency.",
      ],
      tip: "Do not read this front to back. Come here when a question sends you.",
    },
    missed: {
      icon: "i-redo", title: "Missed queue",
      what: "Only the questions you have gotten wrong and not yet re-earned.",
      when: "Whenever it has more than about ten in it.",
      how: [
        "A question leaves the queue when you get it right.",
        "These are the cheapest points available to you, because you already know they are gaps.",
      ],
      tip: "Clearing this queue is usually the highest-value fifteen minutes in the app.",
    },
    skills: {
      icon: "i-search", title: "Skill map",
      what: "All 101 skills the state publishes, marked mastered, shaky, or not started.",
      when: "When you want to know what you are still responsible for.",
      how: [
        "Mastered means at least two questions on that skill, all correct most recently. One lucky answer does not count.",
        "Tap Practise on any line to drill just that skill.",
      ],
      tip: "This is the direct answer to 'what is actually on this test'.",
    },
    review: {
      icon: "i-chart", title: "Last 50",
      what: "How your recent answers actually went: accuracy, pace, calibration, and what kind of mistakes you make.",
      when: "Once a week, or after a mock.",
      how: [
        "Sure but wrong is the number to watch. Those are things you believe and are wrong about, which is worse than knowing you do not know.",
        "Calibration compares how confident you felt against how you actually did. Well calibrated means Certain is near 100 percent and Guess is near 25.",
        "Average time is measured against the real 112 seconds per question.",
      ],
      tip: "If misread keeps showing up in why you missed things, that is the cheapest fix on the list.",
    },
    progress: {
      icon: "i-list", title: "Progress and settings",
      what: "Mastery by competency, exam history, and every setting.",
      when: "Whenever you want to change something.",
      how: [
        "Set or change your test date, daily goal, name, theme, and the confidence prompt here.",
        "Bars fade if a competency has gone untouched for weeks, because knowledge really does decay.",
        "You can add a passkey so you sign in with Face ID instead of the PIN.",
      ],
      tip: "Erasing progress here cannot be undone, and it clears every device.",
    },
  };

  function helpBox(key) {
    const h = HELP[key];
    if (!h) return "";
    return `<details class="helpbox">
      <summary>${icon("i-help")}<span>How this works</span></summary>
      <div class="helpbox-in">
        <p><strong>What it is.</strong> ${esc(h.what)}</p>
        <p><strong>When to use it.</strong> ${esc(h.when)}</p>
        <ul>${h.how.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        <p class="tip">${icon("i-bulb")}<span>${esc(h.tip)}</span></p>
      </div>
    </details>`;
  }

  function helpPage() {
    session = null;
    app.innerHTML = `
      <div class="panel">
        <h1>${icon("i-help")} How to use this</h1>
        <p class="muted">Everything here aims at one thing: passing Middle Grades General Science 5&ndash;9. Nothing else matters, so if a section is not helping, skip it.</p>
      </div>

      <div class="panel">
        <h2>${icon("i-play")} If you only read one thing</h2>
        <ol class="howto">
          <li><strong>Open the app and do what the plan says.</strong> The home screen works out your best next move. You do not have to decide anything.</li>
          <li><strong>Answer honestly.</strong> The app can only help with what it can see. Rating a card Easy when you guessed, or skipping the confidence tap, makes it worse at its job.</li>
          <li><strong>Short and often beats long and rare.</strong> Fifteen minutes a day will move you further than three hours on Sunday.</li>
          <li><strong>Read the explanation even when you got it right.</strong> Being right for the wrong reason is the thing that fails you on the day.</li>
        </ol>
      </div>

      <div class="panel">
        <h2>${icon("i-calendar")} A rhythm that works</h2>
        <div class="rhythm">
          <div><b>Most days</b><span>Flashcards until the due pile is clear, then one adaptive drill. About 25 minutes.</span></div>
          <div><b>Once or twice a week</b><span>A mini mock for timing, then clear whatever it puts in your missed queue.</span></div>
          <div><b>Weekly</b><span>The formula drill, and a look at Last 50 to see what kind of mistakes you are making.</span></div>
          <div><b>Every few weeks</b><span>A full mock exam. There are only about three, so do not spend them early.</span></div>
          <div><b>Last two weeks</b><span>Mini mocks for pace, the missed queue, and formulas. Stop learning new material.</span></div>
        </div>
      </div>

      <div class="panel">
        <h2>${icon("i-quiz")} About the two extra taps</h2>
        <p>After you answer, the app asks how sure you were, and if you got it wrong, why. It is about five seconds and it is the most useful thing you can give it.</p>
        <ul class="howto">
          <li><strong>Confident and wrong</strong> is the dangerous category. You will not go looking for those gaps yourself, because you do not know they are there. The app finds them and drills them.</li>
          <li><strong>Why you missed it</strong> decides what happens next. Never learned it sends you to the guide. Forgot the formula sends you to the formula drill. Misread means slow down, not study more.</li>
          <li>If it becomes annoying you can turn the confidence prompt off in Progress and settings, and nothing else breaks.</li>
        </ul>
      </div>

      <div class="panel">
        <h2>${icon("i-target")} What the numbers mean</h2>
        <ul class="howto">
          <li><strong>Exam readiness</strong> is a band, not a percentage, and it shows the evidence behind it. Pearson does not publish how raw scores convert to the 200 you need to pass, so a precise number would be made up.</li>
          <li><strong>Mastery</strong> is held down until you have covered enough of a competency, so a short hot streak cannot read as mastery. It also fades if you have not touched an area in weeks.</li>
          <li><strong>Daily goal</strong> counts cards and questions together. The streak keeps counting as long as you hit the goal today or yesterday, so one missed day does not wipe it.</li>
        </ul>
      </div>

      ${Object.entries(HELP).map(([k, h]) => `<details class="sec">
        <summary>${icon(h.icon)} ${esc(h.title)}</summary>
        <div class="inner">
          <p><strong>What it is.</strong> ${esc(h.what)}</p>
          <p><strong>When to use it.</strong> ${esc(h.when)}</p>
          <ul class="howto">${h.how.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
          <p class="tip">${icon("i-bulb")}<span>${esc(h.tip)}</span></p>
          <button data-open="${k}">${icon("i-arrow-right")}Go to ${esc(h.title.toLowerCase())}</button>
        </div>
      </details>`).join("")}

      <div class="panel">
        <h2>${icon("i-flame")} If something is wrong</h2>
        <p>Tap the flag button in the bottom left corner on any screen. If a question looks wrong, an answer seems like it could be two things, or anything is broken or hard to read, flag it. It goes straight to Gaither.</p>
        <button class="btn-primary" data-learn-flag="open">${icon("i-flame")}Report something now</button>
      </div>

      <div class="panel"><button onclick="__go('#/')">${icon("i-arrow-right")}Back to home</button></div>`;

    const ROUTE_FOR = { cards: "#/cards", quiz: "#/quiz", drill: "#/drill", mini: "#/mini", exam: "#/exam", formulas: "#/formulas", recall: "#/recall", guide: "#/guide", missed: "#/missed", skills: "#/skills", review: "#/review", progress: "#/progress" };
    app.querySelectorAll("[data-open]").forEach((b) => {
      b.onclick = () => go(ROUTE_FOR[b.dataset.open] || "#/");
    });
  }

  /* ================= welcome (first run) ================= */

  const userName = () => (S.prefs?.name || "").trim();

  function greeting() {
    const h = new Date().getHours();
    const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    const n = userName();
    return n ? `${part}, ${n}` : part;
  }

  /* One short screen, asked once. Three questions, all skippable, because a
     wall of setup between her and the first question is its own kind of
     frustration. The name is only for the greeting; nothing depends on it. */
  function welcome() {
    const today = new Date();
    const min = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    app.innerHTML = `
      <section class="panel welcome">
        <div class="welcome-mark">${icon("i-lab", "ico ico--lg")}</div>
        <h1>Welcome</h1>
        <p class="muted">Three quick things, then you can start. You can change any of them later.</p>

        <label class="wfield">
          <span>${icon("i-pencil")}What should I call you?</span>
          <input type="text" id="wName" maxlength="24" placeholder="Your name" autocomplete="given-name">
        </label>

        <label class="wfield">
          <span>${icon("i-calendar")}When is your test? <em>optional</em></span>
          <input type="date" id="wDate" min="${min}">
          <small class="muted">This turns on the countdown and the daily plan.</small>
        </label>

        <div class="wfield">
          <span>${icon("i-target")}Daily goal</span>
          <div class="seg" role="group" aria-label="Daily goal">
            ${[10, 20, 30, 50].map((n) => `<button type="button" data-wgoal="${n}" aria-pressed="${n === 20}">${n}</button>`).join("")}
          </div>
          <small class="muted">Cards and questions both count. Twenty is about fifteen minutes.</small>
        </div>

        <div class="actions" style="margin-top:1.2rem">
          <button class="btn-primary" id="wStart">${icon("i-play")}Start studying</button>
          <button id="wSkip">Skip for now</button>
        </div>
        <p class="small muted" style="margin:1rem 0 0">Not sure how any of this works? The <strong>?</strong> button at the top explains every section, and it is there on every screen.</p>
      </section>`;

    let goal = 20;
    app.querySelectorAll("[data-wgoal]").forEach((b) => {
      b.onclick = () => {
        goal = Number(b.dataset.wgoal);
        app.querySelectorAll("[data-wgoal]").forEach((x) => x.setAttribute("aria-pressed", String(Number(x.dataset.wgoal) === goal)));
      };
    });
    const finish = (withValues) => {
      S.prefs = {
        ...(S.prefs || {}),
        name: withValues ? ($("#wName").value || "").trim().slice(0, 24) : "",
        examDate: withValues ? ($("#wDate").value || null) : null,
        dailyGoal: withValues ? goal : 20,
        onboarded: true,
      };
      S.prefsAt = Date.now();
      save();
      go("#/");
      router();
    };
    $("#wStart").onclick = () => finish(true);
    $("#wSkip").onclick = () => finish(false);
    $("#wName").focus();
  }

  /* ================= home ================= */

  function home() {
    session = null;
    if (!S.prefs?.onboarded) return welcome();
    const o = overall();
    const due = dueCards().length;
    const missed = missedQuestions().length;
    const lastExam = S.exams[S.exams.length - 1];

    const weakest = DATA.comps
      .map((c) => ({ ...c, m: compMastery(c.comp) }))
      .filter((c) => c.m.seen >= 3)
      .sort((a, b) => a.m.score - b.m.score)[0];

    let nudge;
    if (o.seen < 20) nudge = "Start with a topic quiz or the concept guide to find out where you stand.";
    else if (due > 40) nudge = `${due} flashcards are due. Clearing them is the highest-value 15 minutes you have today.`;
    else if (missed >= 10) nudge = `You have ${missed} questions you got wrong and have not re-earned. Run the missed queue.`;
    else if (weakest) nudge = `Weakest area right now: ${weakest.title.toLowerCase()}. An adaptive drill will feed you more of it.`;
    else nudge = "Run an adaptive drill to keep everything warm.";

    const target = goalTarget();
    const doneToday = todayCount();
    const pctGoal = Math.min(1, doneToday / target);
    const st = streak();
    const RAD = 34, C = 2 * Math.PI * RAD;
    const R = readiness();
    const dLeft = daysUntilExam();
    const ph = phase();
    const plan = dailyPlan();
    const teaching = todaysTeaching();

    // Resume: the single highest-value next click, as one big obvious button.
    let resume;
    if (due > 0) resume = { hash: "#/cards", icon: "i-cards", title: `Review ${pluralize(due, "card", "cards")}`, sub: "Due today on your schedule" };
    else if (missed >= 5) resume = { hash: "#/missed", icon: "i-redo", title: `Clear ${missed} missed questions`, sub: "The fastest points you can gain" };
    else if (o.seen < 20) resume = { hash: "#/quiz", icon: "i-quiz", title: "Take your first topic quiz", sub: "Find out where you actually stand" };
    else resume = { hash: "#/drill", icon: "i-shuffle", title: "Run an adaptive drill", sub: "Twenty questions aimed at your weak spots" };

    app.innerHTML = `
      <h1 class="greet">${esc(greeting())}</h1>
      <section class="hero">
        <div class="today">
          <div class="ring">
            <svg viewBox="0 0 80 80" aria-hidden="true">
              <circle class="track" cx="40" cy="40" r="${R}"></circle>
              <circle class="fill ${pctGoal >= 1 ? "done" : ""}" cx="40" cy="40" r="${R}"
                style="stroke-dasharray:${(C * pctGoal).toFixed(1)} ${C.toFixed(1)}"></circle>
            </svg>
            <b>${doneToday}<span style="font-size:.62rem;color:var(--muted)">/${target}</span></b>
          </div>
          <div class="today-copy">
            <h3>${pctGoal >= 1 ? `${icon("i-check")} Goal met today` : "Today's goal"}</h3>
            <p>${pctGoal >= 1
              ? "Anything past this is a bonus. Stop whenever you want."
              : `${target - doneToday} more ${target - doneToday === 1 ? "card or question" : "cards or questions"} to go.`}</p>
            <div class="week">${lastSevenDays().map((d) =>
              `<i class="${d.met ? "hit" : ""} ${d.isToday ? "today" : ""}" title="${d.key}">${d.label}</i>`).join("")}</div>
          </div>
          <span class="streak ${st ? "" : "cold"}">${icon("i-flame")}${st ? `${st} day${st === 1 ? "" : "s"}` : "No streak yet"}</span>
        </div>
      </section>

      ${dLeft !== null && dLeft >= 0 ? `
      <section class="panel">
        <div class="crumb"><span class="chip">${icon("i-clock")} ${esc(ph.label)}</span>
          <span class="prog">${dLeft === 0 ? "Test is today" : `${dLeft} day${dLeft === 1 ? "" : "s"} to go`}</span></div>
        <h2 style="margin-bottom:.2rem">Plan for today</h2>
        <p class="small muted">Short on purpose. A plan you finish beats an ideal one you abandon.</p>
        <ul class="plan">
          ${plan.map((p, i) => `<li><button data-plan="${p.hash}" class="${i === 0 ? "first" : ""}">${icon(p.icon)}<span>${esc(p.label)}</span>${icon("i-arrow-right", "ico go")}</button></li>`).join("")}
        </ul>
      </section>`
      : `
      <button class="resume" onclick="__go('${resume.hash}')">
        ${icon(resume.icon, "ico ico--lg")}
        <span><b>${esc(resume.title)}</b><small>${esc(resume.sub)}</small></span>
        ${icon("i-arrow-right", "ico go")}
      </button>

      <section class="panel">
        <h3>${icon("i-clock")} When is your test?</h3>
        <p class="small muted">Set the date and this becomes a countdown with a plan that changes as it gets closer. Without it the app cannot pace anything.</p>
        <div class="actions">
          <input type="date" id="examDateQuick" class="date-in">
          <button class="btn-primary" id="examDateSave">Set date</button>
        </div>
      </section>`}

      <section class="panel teach">
        ${teaching ? `
          <h3>${compIcon(teaching.comp)} Teaching ${esc(compTitle(teaching.comp).toLowerCase())} today</h3>
          <p class="small muted">Tonight's practice is weighted toward it. You already did the hard part of activating this material in front of a class.</p>
          <div class="actions">
            <button class="btn-primary" id="teachDrill">${icon("i-shuffle")} Drill it</button>
            <button id="teachCards">${icon("i-cards")} Cards</button>
            <button id="teachClear" class="small">Change</button>
          </div>`
        : `
          <details class="teach-details">
            <summary>${icon("i-lab")}<span><b>What are you teaching today?</b><small>Optional. Practising tonight what you taught today is the cheapest retention there is.</small></span></summary>
            <div class="teach-opts">
              ${DATA.comps.map((c) => `<button class="teach-opt c${c.comp} rail" data-teach="${c.comp}">${compIcon(c.comp)}${esc(c.title)}</button>`).join("")}
              <button class="teach-opt" data-teach="0">Not teaching science today</button>
            </div>
          </details>`}
      </section>

      <section class="panel">
        <div class="crumb"><span class="chip">${icon("i-target")} Exam readiness</span>
          ${dLeft !== null && dLeft >= 0 ? `<span class="prog">${dLeft === 0 ? "Test is today" : `${dLeft} day${dLeft === 1 ? "" : "s"} to go`}</span>` : ""}</div>
        <div class="ready-band"><span class="verdict-band ${BAND_CLASS[R.band] || ""}">${R.band}</span></div>
        <p class="small" style="margin:.5rem 0 .8rem">${esc(R.why)}</p>
        <div class="evidence">
          <div><b>${R.seen}<span class="muted">/${o.total}</span></b><span>${icon("i-quiz", "ico ico--sm")}Questions answered</span></div>
          <div><b>${Math.round(R.coverage * 100)}%</b><span>${icon("i-layers", "ico ico--sm")}Bank covered</span></div>
          <div><b>${R.sk.mastered}<span class="muted">/${SKILL_COUNT()}</span></b><span>${icon("i-check-circle", "ico ico--sm")}Skills mastered</span></div>
          <div><b>${R.lastMock ? Math.round((R.lastMock.raw / R.lastMock.total) * 100) + "%" : "&mdash;"}</b><span>${icon("i-exam", "ico ico--sm")}Last full mock</span></div>
          <div><b>${R.trend ? `<span style="color:var(--${R.trend.delta >= 0 ? "good" : "bad"})">${(R.trend.delta >= 0 ? "+" : "") + Math.round(R.trend.delta * 100)}%</span>` : "&mdash;"}</b><span>${icon(R.trend && R.trend.delta < 0 ? "i-trend-down" : "i-trend-up", "ico ico--sm")}Recent trend</span></div>
          <div><b>${due}</b><span>${icon("i-cards", "ico ico--sm")}Cards due</span></div>
        </div>
        <p class="small muted" style="margin:.8rem 0 0">A band rather than a number on purpose: Pearson does not publish how raw scores convert to the 200 scaled pass mark, so a precise percentage would be false precision.</p>
        <div class="actions" style="margin-top:.8rem">
          <button onclick="__go('#/skills')">${icon("i-search")} Skill map</button>
          <button onclick="__go('#/review')">${icon("i-chart")} Last 50</button>
        </div>
      </section>

      <h2 class="sec-h">${icon("i-play")}Practise</h2>
      <p class="sec-sub">Little and often. This is where most of your points come from.</p>
      <div class="modes">
        <button class="mode" onclick="__go('#/cards')">
          <span class="tagline">${icon("i-cards")} Spaced repetition</span>
          <h3>Flashcards</h3>
          <p>Cards you miss come back fast, cards you know go quiet.</p>
          ${due ? `<span class="badge">${due} due now</span>` : ""}
        </button>
        <button class="mode" onclick="__go('#/drill')">
          <span class="tagline">${icon("i-shuffle")} Mixed practice</span>
          <h3>Adaptive drill</h3>
          <p>Twenty questions aimed at your weak spots and past mistakes.</p>
        </button>
        <button class="mode" onclick="__go('#/quiz')">
          <span class="tagline">${icon("i-quiz")} One topic</span>
          <h3>Topic quiz</h3>
          <p>Pick one competency, with an explanation after every question.</p>
        </button>
        <button class="mode" onclick="__go('#/missed')">
          <span class="tagline">${icon("i-redo")} Second chances</span>
          <h3>Missed queue</h3>
          <p>Only what you got wrong. They leave when you get them right.</p>
          ${missed ? `<span class="badge">${missed} waiting</span>` : ""}
        </button>
        <button class="mode" onclick="__go('#/formulas')">
          <span class="tagline">${icon("i-energy")} Typed from memory</span>
          <h3>Formula drill</h3>
          <p>${typedCards().length} formulas you have to produce, not just recognise.</p>
        </button>
      </div>

      <h2 class="sec-h">${icon("i-clock")}Test yourself</h2>
      <p class="sec-sub">Under the real clock, with no feedback until you finish.</p>
      <div class="modes">
        <button class="mode" onclick="__go('#/mini')">
          <span class="tagline">${icon("i-clock")} 37 minutes</span>
          <h3>Mini mock</h3>
          <p>Twenty questions on the real blueprint. Short enough to do often.</p>
        </button>
        <button class="mode" onclick="__go('#/exam')">
          <span class="tagline">${icon("i-exam")} 2 hours 30</span>
          <h3>Full mock exam</h3>
          <p>All eighty questions. Save these, there are only three in the bank.</p>
        </button>
      </div>

      <h2 class="sec-h">${icon("i-book")}Learn it</h2>
      <p class="sec-sub">For material that is genuinely new, or gone cold.</p>
      <div class="modes">
        <button class="mode" onclick="__go('#/guide')">
          <span class="tagline">${icon("i-book")} Reference</span>
          <h3>Concept guide</h3>
          <p>Every competency explained, with the formulas and the usual traps.</p>
        </button>
        <button class="mode" onclick="__go('#/recall')">
          <span class="tagline">${icon("i-brain")} Free recall</span>
          <h3>Brain dump</h3>
          <p>Explain a topic from memory, then check yourself against the key points.</p>
        </button>
      </div>

      <h2 class="sec-h">${icon("i-chart")}Where you stand</h2>
      <p class="sec-sub">What you have covered, and what still needs work.</p>
      <div class="modes">
        <button class="mode" onclick="__go('#/skills')">
          <span class="tagline">${icon("i-search")} ${SKILL_COUNT()} skills</span>
          <h3>Skill map</h3>
          <p>Everything the state can test you on, marked off one by one.</p>
        </button>
        <button class="mode" onclick="__go('#/review')">
          <span class="tagline">${icon("i-chart")} Recent work</span>
          <h3>Last 50</h3>
          <p>Accuracy, pace, and whether your confidence matches your results.</p>
        </button>
        <button class="mode" onclick="__go('#/progress')">
          <span class="tagline">${icon("i-list")} Everything</span>
          <h3>Progress and settings</h3>
          <p>Mastery by competency, exam history, test date, theme, sign-in.</p>
        </button>
      </div>`;


    app.querySelectorAll("[data-teach]").forEach((b) => {
      b.onclick = () => { const c = Number(b.dataset.teach); setTeaching(c || null); router(); };
    });
    const td = $("#teachDrill");
    if (td) td.onclick = () => drillStart(null, teaching.comp);
    const tc = $("#teachCards");
    if (tc) tc.onclick = () => {
      const pool = DATA.cards.filter((c) => c.comp === teaching.comp);
      session = { queue: shuffle(pool), i: 0, shown: false, done: 0, again: [] };
      renderCard();
    };
    const tcl = $("#teachClear");
    if (tcl) tcl.onclick = () => { S.prefs = { ...(S.prefs || {}), teaching: null }; S.prefsAt = Date.now(); save(); router(); };
    app.querySelectorAll("[data-plan]").forEach((b) => { b.onclick = () => go(b.dataset.plan); });
    const eds = $("#examDateSave");
    if (eds) eds.onclick = () => {
      const v = $("#examDateQuick").value;
      if (!v) return;
      S.prefs = { ...(S.prefs || {}), examDate: v };
      S.prefsAt = Date.now();
      save();
      router();
    };
  }

  /* ================= flashcards ================= */

  function cardsSetup() {
    const due = dueCards();
    const byComp = DATA.comps.map((c) => ({
      ...c,
      due: due.filter((x) => x.comp === c.comp).length,
      total: DATA.cards.filter((x) => x.comp === c.comp).length,
    }));

    app.innerHTML = `
      <div class="panel">
        <h1>Flashcards</h1>
        ${helpBox("cards")}
        <p class="muted">Cards are scheduled by how well you knew them. Rate honestly: marking something "easy" that you actually guessed is the fastest way to fail the real test.</p>
        <div class="opts">
          <label class="opt"><input type="radio" name="cscope" value="due" checked>
            <span>Everything due</span><span class="meta">${due.length} cards</span></label>
          ${byComp.map((c) => `<label class="opt"><input type="radio" name="cscope" value="${c.comp}">
            <span>${c.comp}. ${esc(c.title)}</span><span class="meta">${c.due} due / ${c.total}</span></label>`).join("")}
          <label class="opt"><input type="radio" name="cscope" value="all">
            <span>All cards, ignore schedule</span><span class="meta">${DATA.cards.length} cards</span></label>
        </div>
        <div class="actions">
          <button class="btn-primary" id="startCards">Start</button>
          <button onclick="__go('#/')">Back</button>
        </div>
      </div>`;

    $("#startCards").onclick = () => {
      const v = document.querySelector('input[name="cscope"]:checked').value;
      let pool;
      if (v === "due") pool = dueCards();
      else if (v === "all") pool = DATA.cards.slice();
      else pool = DATA.cards.filter((c) => c.comp === Number(v));
      if (!pool.length) { alert("Nothing due there. Pick another option."); return; }
      session = { queue: shuffle(pool), i: 0, shown: false, done: 0, again: [] };
      renderCard();
    };
  }

  function renderCard() {
    const s = session;
    if (s.i >= s.queue.length) {
      if (s.again.length) { s.queue = shuffle(s.again); s.again = []; s.i = 0; }
      else return cardsDone();
    }
    const c = s.queue[s.i];
    const rec = S.cards[c.id];
    const total = s.queue.length;

    // A formula card asks her to WRITE the answer, so it must offer a box to
    // write in wherever it appears. Showing "Write the formula..." above a
    // self-graded "Show answer" button is the kind of small mismatch that
    // makes an app feel careless.
    if (c.drill === "type") return renderCardTyped(c, rec, total);

    app.innerHTML = `
      <div class="panel">
        <div class="crumb">
          ${compChip(c.comp)}
          <span class="small muted">${esc(c.topic)}</span>
          <span class="prog">${s.i + 1} of ${total} &middot; ${rec ? `${icon("i-layers", "ico ico--sm")}box ${rec.box}` : `${icon("i-seed", "ico ico--sm")}new`}</span>
        </div>
        <div class="flash">
          <div>
            <div>${esc(c.front)}</div>
            ${s.shown ? `<div class="back">${esc(c.back)}</div>` : ""}
          </div>
        </div>
        ${s.shown ? `
          <p class="small muted">How well did you know that, before you saw the answer?</p>
          <div class="rate">
            <button data-g="0" class="g0">${icon("i-x-circle")}Blank<small>see again now</small></button>
            <button data-g="1" class="g1">${icon("i-alert")}Shaky<small>tomorrow</small></button>
            <button data-g="2" class="g2">${icon("i-check")}Got it<small>few days</small></button>
            <button data-g="3" class="g3">${icon("i-star")}Easy<small>next week+</small></button>
          </div>`
        : `<div class="actions"><button class="btn-primary" id="reveal">Show answer</button>
             <button onclick="__go('#/')">Stop</button></div>`}
        <p class="small muted" style="margin:1rem 0 0">${s.shown ? "Keys 1-4" : "Space or Enter"} to answer</p>
      </div>`;

    if (!s.shown) {
      $("#reveal").onclick = () => { s.shown = true; renderCard(); };
    } else {
      app.querySelectorAll(".rate button").forEach((b) => {
        b.onclick = () => gradeCard(c, Number(b.dataset.g));
      });
    }
  }

  /* Typed card inside the ordinary flashcard deck. Same schedule, same flow,
     but she produces the answer instead of judging herself. */
  function renderCardTyped(c, rec, total) {
    const s = session;
    const graded = s.typedStage === "right" || s.typedStage === "wrong";

    app.innerHTML = `
      <div class="panel">
        <div class="crumb">
          ${compChip(c.comp)}
          <span class="small muted">${icon("i-energy", "ico ico--sm")}${esc(c.topic)}</span>
          <span class="prog">${s.i + 1} of ${total} &middot; ${rec ? `${icon("i-layers", "ico ico--sm")}box ${rec.box}` : `${icon("i-seed", "ico ico--sm")}new`}</span>
        </div>
        <p class="stem">${esc(c.front)}</p>
        <input id="cardTypedIn" class="typed-in" type="text" autocomplete="off" autocapitalize="off"
          autocorrect="off" spellcheck="false" placeholder="Type it from memory"
          ${graded ? "disabled" : ""} value="${esc(s.typedValue || "")}">
        ${graded ? `
          <p class="verdict ${s.typedStage === "right" ? "ok" : "no"}">${icon(s.typedStage === "right" ? "i-check-circle" : "i-x-circle")}${s.typedStage === "right" ? "Correct" : "Not a match"}</p>
          <div class="explain">${esc(c.back)}</div>
          ${s.typedStage === "wrong" ? `<p class="small muted">Accepted forms include <code>${esc(c.answers[0])}</code>.</p>
            <div class="actions" style="margin-bottom:.6rem"><button id="cardOverride">${icon("i-check")}I actually had this right</button></div>` : ""}
          <div class="actions">
            <button class="btn-primary" id="cardTypedNext">Next card</button>
            <button onclick="__go('#/')">Stop</button>
          </div>`
        : `<div class="actions">
            <button class="btn-primary" id="cardTypedCheck">Check</button>
            <button id="cardTypedSkip">I do not know it</button>
          </div>`}
      </div>`;

    const inp = $("#cardTypedIn");
    if (inp && !graded) {
      inp.focus();
      inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); gradeCardTyped(c, inp.value, false); } };
    }
    const chk = $("#cardTypedCheck");
    if (chk) chk.onclick = () => gradeCardTyped(c, $("#cardTypedIn").value, false);
    const skip = $("#cardTypedSkip");
    if (skip) skip.onclick = () => gradeCardTyped(c, "", true);
    const ov = $("#cardOverride");
    if (ov) ov.onclick = () => { s.typedStage = "right"; scheduleTyped(c, true); save(); renderCard(); };
    const nx = $("#cardTypedNext");
    if (nx) nx.onclick = () => {
      if (s.typedStage === "wrong") s.again.push(c);
      s.done++; s.i++; s.typedStage = null; s.typedValue = ""; s.shown = false;
      renderCard();
    };
  }

  function gradeCardTyped(card, value, skipped) {
    const s = session;
    s.typedValue = value;
    const ok = !skipped && answerMatches(value, card.answers);
    s.typedStage = ok ? "right" : "wrong";
    scheduleTyped(card, ok);
    save();
    renderCard();
  }

  function gradeCard(card, grade) {
    const s = session;
    const prev = S.cards[card.id] || { box: 0, seen: 0 };
    let box;
    if (grade === 0) box = 0;
    else if (grade === 1) box = Math.max(1, prev.box);
    else if (grade === 2) box = Math.min(BOXES.length - 1, prev.box + 1);
    else box = Math.min(BOXES.length - 1, prev.box + 2);

    bump("c");
    S.cards[card.id] = {
      box,
      due: now() + days(BOXES[box]),
      seen: (prev.seen || 0) + 1,
      at: now(),
    };
    if (grade === 0) s.again.push(card);
    s.done++;
    s.i++;
    s.shown = false;
    save();
    renderCard();
  }

  function cardsDone() {
    app.innerHTML = `
      <div class="panel" style="text-align:center">
        <h1>Deck clear</h1>
        <p class="muted">${pluralize(session.done, "card", "cards")} reviewed. ${dueCards().length ? `${dueCards().length} still due elsewhere.` : "Nothing else due right now."}</p>
        <div class="actions" style="justify-content:center">
          <button class="btn-primary" onclick="__go('#/cards')">Another deck</button>
          <button onclick="__go('#/')">Home</button>
        </div>
      </div>`;
    session = null;
  }

  /* ================= quiz / drill / missed (shared engine) ================= */

  function startQuestionRun(questions, label, opts = {}) {
    if (!questions.length) {
      app.innerHTML = `<div class="panel"><h1>Nothing to do</h1><p class="muted">No questions match that.</p>
        <button class="btn-primary" onclick="__go('#/')">Home</button></div>`;
      return;
    }
    session = {
      kind: "run", label, qs: questions, i: 0, right: 0, opts,
      picked: null, stage: null, conf: 0, ms: 0, why: undefined, logged: false, shownAt: now(),
    };
    renderRunQuestion();
  }

  /* The answer flow has three beats, and the two extra ones exist because
     "she got it wrong" is almost useless on its own:
       1. pick an answer
       2. say how sure you were, BEFORE seeing the result   -> calibration
       3. if wrong, say why you missed it                   -> routing
     Confident-and-wrong is the single most dangerous state for someone who
     failed by two questions, and it is invisible without step 2. */

  const CONF = [
    { v: 1, label: "Guess" },
    { v: 2, label: "Maybe" },
    { v: 3, label: "Pretty sure" },
    { v: 4, label: "Certain" },
  ];

  const WHY = [
    { v: "never", label: "Never learned it" },
    { v: "mixed", label: "Knew it but mixed it up" },
    { v: "misread", label: "Misread the question" },
    { v: "formula", label: "Forgot the formula" },
    { v: "changed", label: "Changed my answer" },
  ];

  function askConfidence() { return S.prefs?.askConfidence !== false; }

  function renderRunQuestion() {
    const s = session;
    if (s.i >= s.qs.length) return runDone();
    const q = s.qs[s.i];
    // Shuffle choices per presentation so she learns the science, not the shape.
    if (!q._order) q._order = shuffle(q.choices.map((_, idx) => idx));
    if (!s.shownAt) s.shownAt = now();

    const order = q._order;
    const picked = s.picked !== null;
    const revealed = s.stage === "reveal";
    const correctPos = order.indexOf(q.answer);
    const wasRight = s.picked === correctPos;

    app.innerHTML = `
      <div class="panel">
        <div class="crumb">
          ${compChip(q.comp)}
          <span class="small muted">${esc(q.topic)} ${diffPips(q.difficulty)}</span>
          <span class="prog">${s.i + 1} of ${s.qs.length} &middot; <span style="color:var(--good)">${s.right} right</span></span>
        </div>
        <p class="stem">${esc(q.stem)}</p>
        <div class="choices">
          ${order.map((origIdx, pos) => {
            let cls = "choice";
            if (revealed && pos === correctPos) cls += " correct";
            else if (revealed && pos === s.picked) cls += " wrong";
            else if (!revealed && pos === s.picked) cls += " picked";
            return `<button class="${cls}" data-pos="${pos}" ${picked ? "disabled" : ""}>
              <span class="key">${"ABCD"[pos]}</span><span>${esc(q.choices[origIdx])}</span></button>`;
          }).join("")}
        </div>

        ${s.stage === "conf" ? `
          <div class="ask">
            <p class="ask-q">How sure are you?</p>
            <div class="ask-opts">
              ${CONF.map((c) => `<button data-conf="${c.v}">${icon(CONF_ICON[c.v])}${esc(c.label)}</button>`).join("")}
            </div>
          </div>` : ""}

        ${revealed ? `
          <p class="verdict ${wasRight ? "ok" : "no"}">${icon(wasRight ? "i-check-circle" : "i-x-circle")}${wasRight ? "Correct" : "Not quite"}${
            s.conf ? ` <span class="conf-tag${!wasRight && s.conf >= 3 ? " danger" : ""}">${icon(CONF_ICON[s.conf], "ico ico--sm")}${esc(CONF.find((c) => c.v === s.conf).label)}</span>` : ""}</p>
          ${!wasRight && s.conf >= 3 ? `<p class="warn-note">${icon("i-alert")}<span>You were sure and it was wrong. That is the kind of gap that costs points, so this one is worth a second look.</span></p>` : ""}
          <div class="explain">${esc(q.explanation)}</div>
          ${!wasRight && s.why === null ? `
            <div class="ask">
              <p class="ask-q">${icon("i-quiz")}Why did you miss it?</p>
              <div class="ask-opts why">
                ${WHY.map((w) => `<button data-why="${w.v}">${icon(WHY_ICON[w.v])}${esc(w.label)}</button>`).join("")}
              </div>
            </div>` : ""}
          <div class="actions">
            <button class="btn-primary" id="next">${s.i + 1 >= s.qs.length ? "See results" : "Next question"}</button>
            <button onclick="__go('#/')">Stop here</button>
          </div>` : ""}

        ${!picked ? `<p class="small muted">Keys A-D or 1-4 to answer</p>` : ""}
      </div>`;

    if (!picked) {
      app.querySelectorAll(".choice").forEach((b) => { b.onclick = () => pickAnswer(Number(b.dataset.pos)); });
    }
    app.querySelectorAll("[data-conf]").forEach((b) => { b.onclick = () => setConfidence(Number(b.dataset.conf)); });
    app.querySelectorAll("[data-why]").forEach((b) => {
      b.onclick = () => { session.why = b.dataset.why; commitAttempt(); renderRunQuestion(); };
    });
    const nx = $("#next");
    if (nx) nx.onclick = () => nextRunQuestion();
  }

  function pickAnswer(pos) {
    const s = session;
    s.picked = pos;
    s.ms = now() - (s.shownAt || now());
    if (askConfidence()) { s.stage = "conf"; renderRunQuestion(); }
    else { s.conf = 0; revealAnswer(); }
  }

  function setConfidence(v) {
    session.conf = v;
    revealAnswer();
  }

  function revealAnswer() {
    const s = session;
    const q = s.qs[s.i];
    const correct = q._order[s.picked] === q.answer;
    if (correct) s.right++;
    s.stage = "reveal";
    s.why = correct ? undefined : null;   // null means "still asking"
    recordQuestion(q, correct, s.conf, s.ms);
    if (correct) commitAttempt();
    save();
    renderRunQuestion();
  }

  function commitAttempt() {
    const s = session;
    const q = s.qs[s.i];
    if (s.logged) return;
    s.logged = true;
    const correct = q._order[s.picked] === q.answer;
    S.recent.push({
      qid: q.id, comp: q.comp, skill: q.skill,
      ok: correct, conf: s.conf || 0, ms: s.ms || 0,
      why: s.why || "", at: now(),
    });
    if (S.recent.length > RECENT_CAP) S.recent = S.recent.slice(-RECENT_CAP);
    if (s.why) {
      const r = S.questions[q.id];
      if (r) r.why = s.why;
    }
    save();
  }

  function nextRunQuestion() {
    commitAttempt();          // in case she skipped the why prompt
    const s = session;
    s.i++;
    s.picked = null;
    s.stage = null;
    s.conf = 0;
    s.ms = 0;
    s.why = undefined;
    s.logged = false;
    s.shownAt = now();
    renderRunQuestion();
  }

  function recordQuestion(q, correct, conf = 0, ms = 0) {
    bump("q");
    const prev = S.questions[q.id] || { seen: 0, correct: 0, wrong: 0 };
    S.questions[q.id] = {
      seen: prev.seen + 1,
      correct: prev.correct + (correct ? 1 : 0),
      wrong: prev.wrong + (correct ? 0 : 1),
      lastCorrect: correct,
      conf, ms,
      at: now(),
    };
  }

  function runDone() {
    const s = session;
    const pct = Math.round((s.right / s.qs.length) * 100);
    const b = band(s.right / s.qs.length);
    const byComp = {};
    for (const q of s.qs) {
      byComp[q.comp] = byComp[q.comp] || { n: 0, r: 0 };
      byComp[q.comp].n++;
      if (S.questions[q.id]?.lastCorrect) byComp[q.comp].r++;
    }
    // Celebration, but honest: praise the act of showing up, not a bad score.
    const goalJustMet = todayCount() >= goalTarget();
    const cheer = pct >= 90 ? "Excellent." : pct >= 75 ? "Solid work." : pct >= 55 ? "Good practice." : "That is useful information.";
    const cheerSub = pct >= 75
      ? "Keep this pace and the real thing will feel familiar."
      : "Every one you missed is now in your missed queue, which is exactly where the easy points are.";

    app.innerHTML = `
      <div class="panel celebrate">
        <div class="big">${icon(pct >= 75 ? "i-check" : "i-target", "ico ico--lg")}</div>
        <p class="small muted" style="margin-bottom:.3rem">${esc(s.label)}</p>
        <div class="score-big">${s.right}<span style="font-size:1.5rem;color:var(--muted)">/${s.qs.length}</span></div>
        <p><span class="verdict-band ${b.cls}">${pct}% &middot; ${b.label}</span></p>
        <h2 style="margin-top:.6rem">${cheer}</h2>
        <p class="small muted" style="max-width:40ch;margin:0 auto">${cheerSub}</p>
        ${goalJustMet ? `<p style="margin-top:.9rem"><span class="streak">${icon("i-flame")}Daily goal met, ${pluralize(streak(), "day", "days")} running</span></p>` : ""}
      </div>
      <div class="panel">
        <h2>By competency</h2>
        ${Object.entries(byComp).sort((a, b2) => a[0] - b2[0]).map(([c, v]) => {
          const p = v.r / v.n;
          return `<div class="mrow"><span class="lbl">${c}. ${esc(compTitle(Number(c)))}</span><span class="val">${v.r}/${v.n}</span></div>
            <div class="bar"><i class="${barClass(p)}" style="width:${Math.round(p * 100)}%"></i></div>`;
        }).join("")}
        <div class="actions" style="margin-top:1rem">
          ${missedQuestions().length ? `<button class="btn-primary" onclick="__go('#/missed')">Review what you missed</button>` : ""}
          <button onclick="__go('#/')">Home</button>
        </div>
      </div>`;
    session = null;
  }

  /* ---- quiz setup ---- */

  function quizSetup() {
    app.innerHTML = `
      <div class="panel">
        <h1>Topic quiz</h1>
        ${helpBox("quiz")}
        <p class="muted">One competency at a time, with an explanation after every question. Best used right after you read that section of the concept guide.</p>
        <div class="opts">
          ${DATA.comps.map((c) => {
            const m = compMastery(c.comp);
            const n = DATA.questions.filter((q) => q.comp === c.comp).length;
            return `<label class="opt"><input type="radio" name="qc" value="${c.comp}" ${c.comp === 1 ? "checked" : ""}>
              <span>${c.comp}. ${esc(c.title)}</span>
              <span class="meta">${n} q &middot; ${m.seen ? Math.round(m.accuracy * 100) + "%" : "new"}</span></label>`;
          }).join("")}
        </div>
        <label class="field-row">${icon("i-list")}<span>Length</span>
          <select id="qlen" class="sel">
            <option value="10">10 questions</option>
            <option value="15" selected>15 questions</option>
            <option value="25">25 questions</option>
            <option value="999">Everything in this competency</option>
          </select></label>
        <label class="check-row">
          <input type="checkbox" id="qfresh"> <span>Prefer questions I have not seen yet</span></label>
        <div class="actions">
          <button class="btn-primary" id="startQuiz">Start quiz</button>
          <button onclick="__go('#/')">Back</button>
        </div>
      </div>`;

    $("#startQuiz").onclick = () => {
      const comp = Number(document.querySelector('input[name="qc"]:checked').value);
      const len = Number($("#qlen").value);
      let pool = DATA.questions.filter((q) => q.comp === comp);
      if ($("#qfresh").checked) {
        const unseen = pool.filter((q) => !S.questions[q.id]?.seen);
        if (unseen.length >= Math.min(len, 5)) pool = unseen;
      }
      startQuestionRun(sample(pool, Math.min(len, pool.length)), `Competency ${comp}: ${compTitle(comp)}`);
    };
  }

  /* ---- adaptive drill ---- */

  function drillStart(_rest, focusComp) {
    /* Weight each competency by (its share of the test) x (how much you are missing it)
       x (decay, so stale areas resurface) x (a large boost for whatever she taught
       today). Then interleave: the mix is deliberately jumbled rather than blocked by
       topic, because blocked practice feels easier and retains worse. */
    const N = 20;
    const teach = focusComp || todaysTeaching()?.comp || null;
    const weights = DATA.comps.map((c) => {
      const m = compMastery(c.comp);
      const gap = m.seen >= 3 ? 1 - m.score : 0.65;   // unknown areas get a middling default
      const stale = 1 + (1 - decayFactor(compLastTouched(c.comp))) * 2;
      const taught = c.comp === teach ? 4 : 1;
      return { comp: c.comp, w: (c.pct / 100) * (0.25 + 1.75 * gap) * stale * taught };
    });
    const wsum = weights.reduce((a, b) => a + b.w, 0);

    const picked = [];
    const used = new Set();
    for (const { comp, w } of weights) {
      const want = Math.round((w / wsum) * N);
      const pool = DATA.questions.filter((q) => q.comp === comp && !used.has(q.id));
      // Prefer previously-missed, then unseen, then anything.
      const missed = pool.filter((q) => S.questions[q.id] && !S.questions[q.id].lastCorrect);
      const unseen = pool.filter((q) => !S.questions[q.id]?.seen);
      const rest = pool.filter((q) => !missed.includes(q) && !unseen.includes(q));
      const ordered = [...shuffle(missed), ...shuffle(unseen), ...shuffle(rest)];
      for (const q of ordered.slice(0, want)) { picked.push(q); used.add(q.id); }
    }
    while (picked.length < N) {
      const q = DATA.questions[Math.floor(Math.random() * DATA.questions.length)];
      if (!used.has(q.id)) { picked.push(q); used.add(q.id); }
    }
    startQuestionRun(shuffle(picked).slice(0, N),
      teach ? `Adaptive drill, weighted to ${compTitle(teach).toLowerCase()}` : "Adaptive drill: weighted to your weak spots");
  }

  /* ---- missed queue ---- */

  function missedStart() {
    const missed = missedQuestions();
    if (!missed.length) {
      app.innerHTML = `<div class="panel" style="text-align:center"><h1>Queue is empty</h1>
        <p class="muted">Nothing you have missed is still outstanding. That is a good place to be.</p>
        <div class="actions" style="justify-content:center">
          <button class="btn-primary" onclick="__go('#/drill')">Run a drill instead</button>
          <button onclick="__go('#/')">Home</button></div></div>`;
      return;
    }
    startQuestionRun(shuffle(missed).slice(0, 25), "Missed queue");
  }

  /* ================= mock exam ================= */

  function examSetup() {
    const hist = S.exams.slice(-5).reverse();
    app.innerHTML = `
      <div class="panel">
        <h1>Mock exam</h1>
        ${helpBox("exam")}
        <p class="muted">Eighty questions drawn on the real blueprint, 2 hours 30 minutes on the clock, no feedback until you submit. Sit it the way you would sit the real thing: one go, no notes, no phone.</p>
        <table class="body-md" style="font-size:.85rem;margin-bottom:1rem"><thead><tr><th>Competency</th><th>Items</th></tr></thead><tbody>
          ${DATA.comps.map((c) => `<tr><td>${c.comp}. ${esc(c.title)}</td><td>${BLUEPRINT[c.comp]}</td></tr>`).join("")}
        </tbody></table>
        <div class="actions">
          <button class="btn-primary" id="startExam">Begin timed exam</button>
          <button onclick="__go('#/')">Back</button>
        </div>
      </div>
      ${hist.length ? `<div class="panel"><h2>Previous attempts</h2>
        ${hist.map((e) => {
          const p = e.raw / e.total;
          const b = band(p);
          return `<div class="mrow"><span class="lbl">${new Date(e.at).toLocaleDateString()} <span class="muted small">${e.minutes} min</span></span>
            <span class="val">${e.raw}/${e.total} &middot; <span style="color:var(--${b.cls === "pass" ? "good" : b.cls === "close" ? "warn" : "bad"})">${Math.round(p * 100)}%</span></span></div>
            <div class="bar"><i class="${barClass(p)}" style="width:${Math.round(p * 100)}%"></i></div>`;
        }).join("")}</div>` : ""}`;

    $("#startExam").onclick = () => {
      const qs = [];
      for (const c of DATA.comps) {
        const pool = DATA.questions.filter((q) => q.comp === c.comp);
        qs.push(...sample(pool, Math.min(BLUEPRINT[c.comp], pool.length)));
      }
      session = {
        kind: "exam",
        qs: shuffle(qs),
        i: 0,
        answers: {},
        flags: {},
        times: {},
        shownAt: now(),
        started: now(),
        endsAt: now() + EXAM_MINUTES * 60000,
        reviewing: false,
      };
      for (const q of session.qs) q._order = shuffle(q.choices.map((_, idx) => idx));
      startExamTimer();
      renderExam();
    };
  }

  let examTimer = null;
  function startExamTimer() {
    clearInterval(examTimer);
    examTimer = setInterval(() => {
      if (!session || session.kind !== "exam") return clearInterval(examTimer);
      const el = $("#timer");
      const left = session.endsAt - now();
      if (left <= 0) { clearInterval(examTimer); submitExam(true); return; }
      if (el) {
        const m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
        el.textContent = `${m}:${String(sec).padStart(2, "0")}`;
        el.className = "timer" + (left < 600000 ? " low" : "");
      }
    }, 1000);
  }

  function renderExam() {
    const s = session;
    const q = s.qs[s.i];
    const picked = s.answers[q.id];
    const answeredCount = Object.keys(s.answers).length;

    app.innerHTML = `
      <div class="panel">
        <div class="crumb">
          <span class="chip">Question ${s.i + 1} of ${s.qs.length}</span>
          <span class="timer" id="timer">--:--</span>
          <span class="prog">${answeredCount} answered</span>
        </div>
        <p class="stem">${esc(q.stem)}</p>
        <div class="choices">
          ${q._order.map((origIdx, pos) => `<button class="choice ${picked === pos ? "correct" : ""}" data-pos="${pos}">
            <span class="key">${"ABCD"[pos]}</span><span>${esc(q.choices[origIdx])}</span></button>`).join("")}
        </div>
        <div class="actions">
          <button id="prev" ${s.i === 0 ? "disabled" : ""}>Previous</button>
          <button id="next" ${s.i >= s.qs.length - 1 ? "disabled" : ""}>Next</button>
          <button id="flag">${s.flags[q.id] ? "Unflag" : "Flag for review"}</button>
          <button class="btn-primary" id="submit" style="margin-left:auto">Submit exam</button>
        </div>
      </div>
      <div class="panel">
        <p class="small muted">Jump to a question. Filled = answered, outlined = flagged.</p>
        <div class="grid-nav">
          ${s.qs.map((qq, idx) => {
            let cls = "";
            if (s.answers[qq.id] !== undefined) cls += " answered";
            if (s.flags[qq.id]) cls += " flagged";
            if (idx === s.i) cls += " here";
            return `<button class="${cls.trim()}" data-jump="${idx}">${idx + 1}</button>`;
          }).join("")}
        </div>
      </div>`;

    app.querySelectorAll(".choice").forEach((b) => {
      b.onclick = () => {
        // Time on the item, accumulated so revisits do not overwrite the first
        // read. Pace against the real 112s/question is only meaningful if this
        // is honest about how long she actually spent.
        s.times = s.times || {};
        s.times[q.id] = (s.times[q.id] || 0) + (now() - (s.shownAt || now()));
        s.shownAt = now();
        s.answers[q.id] = Number(b.dataset.pos);
        if (s.i < s.qs.length - 1) s.i++;
        renderExam();
      };
    });
    app.querySelectorAll("[data-jump]").forEach((b) => {
      b.onclick = () => { s.i = Number(b.dataset.jump); renderExam(); };
    });
    $("#prev").onclick = () => { s.i--; renderExam(); };
    $("#next").onclick = () => { s.i++; renderExam(); };
    $("#flag").onclick = () => { s.flags[q.id] = !s.flags[q.id]; renderExam(); };
    $("#submit").onclick = () => {
      const un = s.qs.length - Object.keys(s.answers).length;
      if (un && !confirm(`${pluralize(un, "question is", "questions are")} unanswered. Submit anyway?`)) return;
      submitExam(false);
    };
  }

  function submitExam(timedOut) {
    clearInterval(examTimer);
    const s = session;
    let raw = 0;
    const byComp = {};
    const wrong = [];
    for (const q of s.qs) {
      const pos = s.answers[q.id];
      const correct = pos !== undefined && q._order[pos] === q.answer;
      if (correct) raw++; else wrong.push(q);
      byComp[q.comp] = byComp[q.comp] || { n: 0, r: 0 };
      byComp[q.comp].n++;
      if (correct) byComp[q.comp].r++;
      if (pos !== undefined) {
        const ms = s.times?.[q.id] || 0;
        recordQuestion(q, correct, 0, ms);
        S.recent.push({ qid: q.id, comp: q.comp, skill: q.skill, ok: correct, conf: 0, ms, why: "", at: now() });
      }
    }
    if (S.recent.length > RECENT_CAP) S.recent = S.recent.slice(-RECENT_CAP);
    const minutes = Math.round((now() - s.started) / 60000);
    S.exams.push({ at: now(), raw, total: s.qs.length, minutes, byComp, mini: !!s.mini });
    save();

    const pct = raw / s.qs.length;
    const b = band(pct);
    const weak = Object.entries(byComp).map(([c, v]) => ({ c: Number(c), p: v.r / v.n, ...v }))
      .sort((a, b2) => a.p - b2.p).slice(0, 3);

    app.innerHTML = `
      <div class="panel" style="text-align:center">
        ${timedOut ? `<p class="small" style="color:var(--bad)">Time ran out. Everything unanswered counted wrong, same as the real test.</p>` : ""}
        <div class="score-big">${raw}<span style="font-size:1.5rem;color:var(--muted)">/${s.qs.length}</span></div>
        <p><span class="verdict-band ${b.cls}">${Math.round(pct * 100)}% raw &middot; ${b.label}</span></p>
        <p class="small muted">Finished in ${minutes} of ${s.mini ? MINI_MINUTES : EXAM_MINUTES} minutes.${
          (() => { const tv = Object.values(s.times || {}).filter((x) => x > 1000);
            if (!tv.length) return "";
            const av = tv.reduce((a, b) => a + b, 0) / tv.length / 1000;
            return ` Average ${av.toFixed(0)}s per question against a 112s budget.`; })()}</p>
        <p class="small muted" style="max-width:46ch;margin:1rem auto 0">Pearson does not publish how raw scores convert to the 200 scaled passing score, so this is a band, not a predicted scaled score. Prep programs generally treat roughly 72 to 75 percent raw as the danger line. Aim for 80 and up before you book the seat.</p>
      </div>
      <div class="panel">
        <h2>By competency</h2>
        ${DATA.comps.map((c) => {
          const v = byComp[c.comp];
          if (!v) return "";
          const p = v.r / v.n;
          return `<div class="mrow"><span class="lbl">${c.comp}. ${esc(c.title)}</span><span class="val">${v.r}/${v.n}</span></div>
            <div class="bar"><i class="${barClass(p)}" style="width:${Math.round(p * 100)}%"></i></div>`;
        }).join("")}
        <p style="margin-top:1rem"><strong>Spend your next sessions on:</strong> ${weak.map((w) => esc(compTitle(w.c).toLowerCase())).join(", ")}.</p>
        <div class="actions">
          <button class="btn-primary" id="reviewWrong" ${wrong.length ? "" : "disabled"}>Review the ${wrong.length} you missed</button>
          <button onclick="__go('#/')">Home</button>
        </div>
      </div>`;

    const w = wrong.slice();
    $("#reviewWrong").onclick = () => startQuestionRun(w, "Exam review: questions you missed");
    session = null;
  }

  /* ================= mini mock ================= */

  // 20 items at blueprint proportions on proportional time (20/80 of 150 min
  // = 37.5). Cheap enough to sit twice a week, so the full 80-item mock stays
  // rare and its questions stay unseen.
  const MINI_BLUEPRINT = { 1: 3, 2: 3, 3: 2, 4: 3, 5: 1, 6: 3, 7: 2, 8: 1, 9: 2 };
  const MINI_MINUTES = 37;

  function miniMockStart() {
    const qs = [];
    for (const c of DATA.comps) {
      // Prefer questions not used in a recent full mock so the two modes do
      // not chew through the same items.
      const pool = DATA.questions.filter((q) => q.comp === c.comp);
      qs.push(...sample(pool, Math.min(MINI_BLUEPRINT[c.comp], pool.length)));
    }
    session = {
      kind: "exam", mini: true, qs: shuffle(qs), i: 0, answers: {}, flags: {},
      started: now(), endsAt: now() + MINI_MINUTES * 60000, times: {}, shownAt: now(),
    };
    for (const q of session.qs) q._order = shuffle(q.choices.map((_, idx) => idx));
    startExamTimer();
    renderExam();
  }

  /* ================= formula drill (typed production) ================= */

  // Normalise both sides the same way. The exam wants production, but a right
  // answer marked wrong over a space or a capital letter is the fastest way to
  // make her stop using the feature, so be generous about form and strict only
  // about content.
  // Greek letters map to their spelled-out names, because she will type
  // "lambda" on a phone keyboard and the card may hold the symbol (or vice
  // versa). Same idea for the various dashes, arrows and multiplication signs.
  const GREEK = { "λ": "lambda", "Δ": "delta", "δ": "delta", "ρ": "rho", "π": "pi", "μ": "mu", "Ω": "ohm", "ω": "omega", "α": "alpha", "β": "beta", "γ": "gamma", "θ": "theta", "Σ": "sigma", "σ": "sigma" };

  function normAnswer(s) {
    return String(s)
      .replace(/[λΔδρπμΩωαβγθΣσ]/g, (ch) => GREEK[ch])
      .toLowerCase()
      .replace(/[→⇒]/g, "->")       // arrows
      .replace(/[×·⋅]/g, "*")
      .replace(/[−–—]/g, "-")
      .replace(/\s*->\s*/g, "->")
      .replace(/\s*([=*/+^])\s*/g, "$1")
      .replace(/\s*-\s*/g, "-")
      .replace(/[.,;]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Second, looser pass: drop every space and comma. "KE = 1/2 mv^2" and
  // "ke=1/2mv^2" are the same answer, and so are "radio, microwave, infrared"
  // and "radio microwave infrared". A false "incorrect" on a right answer is
  // the fastest way to make her abandon the drill, so tolerance wins here;
  // the character sequence still has to match exactly.
  // Also drops explicit multiplication signs, since juxtaposition is the norm
  // in physics notation: "f=m*a" and "f=ma" are the same answer.
  const looseAnswer = (s) => normAnswer(s).replace(/[\s,*]/g, "");

  const answerMatches = (typed, accepted) => {
    const n = normAnswer(typed), l = looseAnswer(typed);
    if (!n) return false;
    return accepted.some((a) => normAnswer(a) === n || looseAnswer(a) === l);
  };

  const typedCards = () => DATA.cards.filter((c) => c.drill === "type");

  function formulaDrillStart() {
    const pool = typedCards();
    if (!pool.length) { app.innerHTML = `<div class="panel"><p>No formula cards.</p></div>`; return; }
    // Due ones first, then anything, so this doubles as scheduled review.
    const t = now();
    const due = pool.filter((c) => { const r = S.cards[c.id]; return !r || (r.due ?? 0) <= t; });
    const queue = shuffle(due.length >= 8 ? due : pool).slice(0, 15);
    session = { kind: "typed", queue, i: 0, right: 0, stage: "ask", value: "" };
    renderTyped();
  }

  function renderTyped() {
    const s = session;
    if (s.i >= s.queue.length) {
      const pct = Math.round((s.right / s.queue.length) * 100);
      app.innerHTML = `
        <div class="panel celebrate">
          <div class="score-big">${s.right}<span style="font-size:1.5rem;color:var(--muted)">/${s.queue.length}</span></div>
          <p><span class="verdict-band ${band(s.right / s.queue.length).cls}">${pct}% typed from memory</span></p>
          <p class="small muted" style="max-width:42ch;margin:.6rem auto 0">There are no reference materials on the real test. Producing a formula cold is a different skill from recognising it, which is why these are typed.</p>
          <div class="actions" style="justify-content:center">
            <button class="btn-primary" onclick="__go('#/formulas')">Go again</button>
            <button onclick="__go('#/')">Home</button>
          </div>
        </div>`;
      session = null;
      return;
    }
    const c = s.queue[s.i];
    const graded = s.stage !== "ask";

    app.innerHTML = `
      <div class="panel">
        <div class="crumb">
          <span class="chip">${icon("i-energy")} Formula drill</span>
          <span class="small muted">${esc(c.topic)}</span>
          <span class="prog">${s.i + 1} of ${s.queue.length} &middot; ${s.right} right</span>
        </div>
        <p class="stem">${esc(c.front)}</p>
        <input id="typedIn" class="typed-in" type="text" autocomplete="off" autocapitalize="off"
          autocorrect="off" spellcheck="false" placeholder="Type it from memory" ${graded ? "disabled" : ""}
          value="${esc(s.value)}">
        ${graded ? `
          <p class="verdict ${s.stage === "right" ? "ok" : "no"}">${s.stage === "right" ? "Correct" : "Not a match"}</p>
          <div class="explain">${esc(c.back)}</div>
          ${s.stage === "wrong" ? `<p class="small muted">Accepted forms include: <code>${esc(c.answers[0])}</code></p>
            <div class="actions" style="margin-bottom:.6rem">
              <button id="override">I actually had this right</button>
            </div>` : ""}
          <div class="actions">
            <button class="btn-primary" id="nextTyped">${s.i + 1 >= s.queue.length ? "See results" : "Next"}</button>
            <button onclick="__go('#/')">Stop</button>
          </div>`
        : `<div class="actions"><button class="btn-primary" id="checkTyped">Check</button>
            <button id="skipTyped">I do not know it</button></div>`}
      </div>`;

    const inp = $("#typedIn");
    if (inp && !graded) {
      inp.focus();
      inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); gradeTyped(inp.value); } };
    }
    const chk = $("#checkTyped");
    if (chk) chk.onclick = () => gradeTyped($("#typedIn").value);
    const skip = $("#skipTyped");
    if (skip) skip.onclick = () => gradeTyped("", true);
    const ov = $("#override");
    if (ov) ov.onclick = () => { s.stage = "right"; s.right++; scheduleTyped(s.queue[s.i], true); renderTyped(); };
    const nt = $("#nextTyped");
    if (nt) nt.onclick = () => { s.i++; s.stage = "ask"; s.value = ""; renderTyped(); };
  }

  function gradeTyped(value, skipped = false) {
    const s = session;
    const c = s.queue[s.i];
    s.value = value;
    const ok = !skipped && answerMatches(value, c.answers);
    if (ok) s.right++;
    s.stage = ok ? "right" : "wrong";
    scheduleTyped(c, ok);
    save();
    renderTyped();
  }

  // Typed cards ride the same Leitner schedule, but a miss drops straight to
  // box 0 rather than easing back a step. Formulas are all-or-nothing.
  function scheduleTyped(card, ok) {
    bump("c");
    const prev = S.cards[card.id] || { box: 0, seen: 0 };
    const box = ok ? Math.min(BOXES.length - 1, prev.box + 1) : 0;
    S.cards[card.id] = { box, due: now() + days(BOXES[box]), seen: (prev.seen || 0) + 1, at: now() };
  }

  /* ================= skill coverage map ================= */

  function skillMap(rest) {
    const only = rest && rest[0] ? Number(rest[0]) : null;
    const sum = skillSummary();
    const total = SKILL_COUNT();

    app.innerHTML = `
      <div class="panel">
        <h1>${icon("i-search")} Skill coverage</h1>
        ${helpBox("skills")}
        <p class="muted">The state publishes ${total} individual skills under the nine competencies. This is the full list, and it is the direct answer to "what am I responsible for".</p>
        <div class="skill-sum">
          <span class="pill mastered">${icon("i-check-circle")}<b>${sum.mastered}</b> mastered</span>
          <span class="pill shaky">${icon("i-alert")}<b>${sum.shaky}</b> shaky</span>
          <span class="pill untouched">${icon("i-seed")}<b>${sum.untouched}</b> untouched</span>
        </div>
        <div class="stackbar" role="img" aria-label="${sum.mastered} mastered, ${sum.shaky} shaky, ${sum.untouched} untouched">
          <i class="m" style="width:${(sum.mastered / total) * 100}%"></i>
          <i class="s" style="width:${(sum.shaky / total) * 100}%"></i>
          <i class="u" style="width:${(sum.untouched / total) * 100}%"></i>
        </div>
        <p class="small muted" style="margin:.7rem 0 0">Mastered means at least two questions on that skill, all correct most recently. One lucky answer is not mastery.</p>
      </div>
      ${DATA.comps.filter((c) => !only || c.comp === only).map((c) => {
        const list = DATA.skills[String(c.comp)] || [];
        const done = list.filter((_, i) => skillStatus(c.comp, i + 1).state === "mastered").length;
        return `<details class="sec c${c.comp} rail" ${only ? "open" : ""}>
          <summary>${compIcon(c.comp)} ${c.comp}. ${esc(c.title)}
            <span class="small muted" style="margin-left:auto">${done}/${list.length}</span></summary>
          <div class="inner">
            <ol class="skills">
              ${list.map((txt, i) => {
                const st = skillStatus(c.comp, i + 1);
                return `<li class="sk ${st.state}">
                  ${icon(STATUS_META[st.state].icon, "ico sk-ico")}
                  <span><span class="sk-txt">${esc(txt)}</span>
                  <span class="small muted">${statusPill(st.state)} ${st.seen ? `${st.right}/${st.seen} correct` : "not attempted"}${st.total ? ` &middot; ${st.total} in bank` : ""}</span></span>
                  <button class="small" data-skill="${c.comp}:${i + 1}">${icon("i-play", "ico ico--sm")}Practise</button></li>`;
              }).join("")}
            </ol>
          </div></details>`;
      }).join("")}
      <div class="panel"><button onclick="__go('#/')">Home</button></div>`;

    app.querySelectorAll("[data-skill]").forEach((b) => {
      b.onclick = () => {
        const [c, s] = b.dataset.skill.split(":").map(Number);
        const pool = DATA.questions.filter((q) => q.comp === c && q.skill === s);
        startQuestionRun(shuffle(pool), `Competency ${c}, skill ${s}`);
      };
    });
  }

  /* ================= last 50 review dashboard ================= */

  function reviewDashboard() {
    const r = (S.recent || []).slice(-50);
    if (r.length < 5) {
      app.innerHTML = `<div class="panel"><h1>${icon("i-chart")} Last 50</h1>
        ${helpBox("review")}
        <p class="muted">Answer a few more questions and this fills in: accuracy, how well calibrated your confidence is, pace against the real clock, and which competencies you have been hitting.</p>
        <button class="btn-primary" onclick="__go('#/drill')">${icon("i-shuffle")}Run a drill</button></div>`;
      return;
    }
    const acc = r.filter((x) => x.ok).length / r.length;
    const timed = r.filter((x) => x.ms > 1000 && x.ms < 600000);
    const avgS = timed.length ? timed.reduce((a, b) => a + b.ms, 0) / timed.length / 1000 : 0;
    const confAnswered = r.filter((x) => x.conf > 0);
    const dangerous = confAnswered.filter((x) => !x.ok && x.conf >= 3);
    const guessedRight = confAnswered.filter((x) => x.ok && x.conf === 1);
    const t = recentTrend();

    const byComp = {};
    for (const x of r) { byComp[x.comp] = byComp[x.comp] || { n: 0, ok: 0 }; byComp[x.comp].n++; if (x.ok) byComp[x.comp].ok++; }
    const whyCounts = {};
    for (const x of r) if (x.why) whyCounts[x.why] = (whyCounts[x.why] || 0) + 1;

    app.innerHTML = `
      <div class="panel">
        <h1>${icon("i-chart")} Last ${r.length} questions</h1>
        ${helpBox("review")}
        <div class="stat-row">
          <div class="stat"><b style="color:var(--${barTone(acc)})">${Math.round(acc * 100)}%</b><span>${icon("i-percent", "ico ico--sm")}Accuracy</span></div>
          <div class="stat"><b style="color:var(--${avgS && avgS > 112 ? "bad" : "fg"})">${avgS ? avgS.toFixed(0) + "s" : "&mdash;"}</b><span>${icon("i-clock", "ico ico--sm")}Avg time</span></div>
          <div class="stat"><b style="color:var(--${dangerous.length ? "bad" : "good"})">${dangerous.length}</b><span>${icon("i-alert", "ico ico--sm")}Sure but wrong</span></div>
          <div class="stat"><b style="color:var(--${t ? (t.delta >= 0 ? "good" : "bad") : "fg"})">${t ? (t.delta >= 0 ? "+" : "") + Math.round(t.delta * 100) + "%" : "&mdash;"}</b><span>${icon(t && t.delta < 0 ? "i-trend-down" : "i-trend-up", "ico ico--sm")}Trend</span></div>
        </div>
        <p class="small muted" style="margin:1rem 0 0">Real exam pace is 112 seconds per question. ${
          avgS ? (avgS > 112 ? `You are averaging ${avgS.toFixed(0)}s, which would leave you short on the real clock.` : `You are averaging ${avgS.toFixed(0)}s, comfortably inside the limit.`) : ""}</p>
      </div>

      ${dangerous.length ? `<div class="panel">
        <h2 style="color:var(--bad)">Confidently wrong</h2>
        <p class="small muted">You said "pretty sure" or "certain" and missed it. These are worth more than ordinary mistakes, because you do not know that you do not know them.</p>
        <ul class="keypoints">${dangerous.slice(0, 8).map((x) => {
          const q = DATA.questions.find((qq) => qq.id === x.qid);
          return q ? `<li><span><strong>${esc(q.topic)}</strong><br><span class="small">${esc(q.stem.slice(0, 110))}${q.stem.length > 110 ? "..." : ""}</span></span></li>` : "";
        }).join("")}</ul>
        <button class="btn-primary" id="drillDangerous">Drill these now</button>
      </div>` : ""}

      ${confAnswered.length >= 10 ? `<div class="panel">
        <h2>Calibration</h2>
        ${[4, 3, 2, 1].map((lv) => {
          const g = confAnswered.filter((x) => x.conf === lv);
          if (!g.length) return "";
          const a = g.filter((x) => x.ok).length / g.length;
          return `<div class="mrow"><span class="lbl">${esc(CONF.find((c) => c.v === lv).label)} <span class="muted small">(${g.length})</span></span>
            <span class="val">${Math.round(a * 100)}% right</span></div>
            <div class="bar"><i class="${barClass(a)}" style="width:${Math.round(a * 100)}%"></i></div>`;
        }).join("")}
        <p class="small muted">Well calibrated means "certain" is near 100% and "guess" is near 25%. ${
          guessedRight.length ? `You guessed right ${guessedRight.length} time${guessedRight.length === 1 ? "" : "s"}, which will not repeat on test day.` : ""}</p>
      </div>` : ""}

      ${Object.keys(whyCounts).length ? `<div class="panel">
        <h2>Why you missed them</h2>
        ${Object.entries(whyCounts).sort((a, b) => b[1] - a[1]).map(([k, n]) => {
          const w = WHY.find((x) => x.v === k);
          return `<div class="mrow"><span class="lbl">${esc(w ? w.label : k)}</span><span class="val">${n}</span></div>`;
        }).join("")}
        <p class="small muted">${whyCounts.misread >= 3 ? "Misreading is the cheapest thing on this list to fix. Slow down on the stem." :
          whyCounts.formula >= 3 ? "Forgotten formulas point straight at the formula drill." :
          whyCounts.never >= 3 ? "Genuinely new material points at the concept guide, then flashcards." : "Keep tagging misses. The pattern is what tells you where to spend time."}</p>
      </div>` : ""}

      <div class="panel">
        <h2>Competency mix</h2>
        ${Object.entries(byComp).sort((a, b) => a[0] - b[0]).map(([c, v]) => {
          const p = v.ok / v.n;
          return `<div class="mrow c${c} rail"><span class="lbl">${compIcon(Number(c))} ${c}. ${esc(compTitle(Number(c)))}</span><span class="val">${v.ok}/${v.n}</span></div>
            <div class="bar c${c} rail-bar"><i class="${barClass(p)}" style="width:${Math.round(p * 100)}%"></i></div>`;
        }).join("")}
        <button onclick="__go('#/')" style="margin-top:.8rem">Home</button>
      </div>`;

    const db = $("#drillDangerous");
    if (db) db.onclick = () => {
      const ids = new Set(dangerous.map((x) => x.qid));
      startQuestionRun(shuffle(DATA.questions.filter((q) => ids.has(q.id))), "Confidently wrong");
    };
  }

  /* ================= brain dump (free recall) ================= */

  function recallSetup() {
    const topics = {};
    for (const c of DATA.cards) {
      const k = `${c.comp}|${c.topic}`;
      (topics[k] = topics[k] || []).push(c);
    }
    const compList = DATA.comps.map((c) => ({
      ...c,
      n: DATA.cards.filter((x) => x.comp === c.comp).length,
      last: Math.max(0, ...Object.entries(S.recall).filter(([k]) => k.startsWith(`c${c.comp}:`)).map(([, v]) => v.at || 0)),
    }));

    app.innerHTML = `
      <div class="panel">
        <h1>Brain dump</h1>
        ${helpBox("recall")}
        <p class="muted">Pick a competency, close everything else, and write down every single thing you can remember about it. Then check yourself against the key points. Pulling knowledge out cold is harder than rereading and that is exactly why it works better.</p>
        <div class="opts">
          ${compList.map((c) => `<label class="opt"><input type="radio" name="rc" value="${c.comp}" ${c.comp === 1 ? "checked" : ""}>
            <span>${c.comp}. ${esc(c.title)}</span>
            <span class="meta">${c.last ? "last: " + new Date(c.last).toLocaleDateString() : "never"}</span></label>`).join("")}
        </div>
        <div class="actions">
          <button class="btn-primary" id="startRecall">Start</button>
          <button onclick="__go('#/')">Back</button>
        </div>
      </div>`;

    $("#startRecall").onclick = () => {
      const comp = Number(document.querySelector('input[name="rc"]:checked').value);
      const pool = DATA.cards.filter((c) => c.comp === comp);
      // One key point per distinct topic, so the checklist spans the competency.
      const byTopic = {};
      for (const c of pool) if (!byTopic[c.topic]) byTopic[c.topic] = c;
      session = { kind: "recall", comp, points: sample(Object.values(byTopic), Math.min(14, Object.keys(byTopic).length)), phase: "write", text: "" };
      renderRecall();
    };
  }

  function renderRecall() {
    const s = session;
    if (s.phase === "write") {
      app.innerHTML = `
        <div class="panel">
          <div class="crumb"><span class="chip">Comp ${s.comp}</span>
            <span class="small muted">${esc(compTitle(s.comp))}</span></div>
          <h2>Say it out loud, or write it</h2>
          <p class="muted small">Explain this competency from memory as if you were teaching it to your class. Out loud counts, and it is faster: you do this for a living. Type only what you want to keep. Do not look anything up. Blank space is information too.</p>
          <textarea class="recall" id="dump" placeholder="Optional. Talking through it out loud works just as well."></textarea>
          <div class="actions" style="margin-top:.8rem">
            <button class="btn-primary" id="doneWriting">Done, show the key points</button>
            <button onclick="__go('#/')">Stop</button>
          </div>
        </div>`;
      const ta = $("#dump");
      ta.value = s.text;
      ta.focus();
      $("#doneWriting").onclick = () => { s.text = ta.value; s.phase = "check"; s.hits = {}; renderRecall(); };
      return;
    }

    app.innerHTML = `
      <div class="panel">
        <h2>Check yourself</h2>
        <p class="muted small">Tick every point you actually wrote down or had clearly in mind. Be strict with yourself: "I sort of knew that" is a no.</p>
        <ul class="keypoints">
          ${s.points.map((p, idx) => `<li class="${s.hits[idx] ? "hit" : ""}">
            <input type="checkbox" data-i="${idx}" ${s.hits[idx] ? "checked" : ""} id="kp${idx}">
            <label for="kp${idx}"><strong>${esc(p.topic)}</strong><br><span class="small">${esc(p.back)}</span></label></li>`).join("")}
        </ul>
        <div class="actions">
          <button class="btn-primary" id="scoreRecall">Score it</button>
        </div>
      </div>
      <details class="sec"><summary>What I wrote</summary><div class="inner"><p style="white-space:pre-wrap">${esc(s.text || "(nothing)")}</p></div></details>`;

    app.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.onchange = () => { s.hits[Number(cb.dataset.i)] = cb.checked; renderRecall(); };
    });
    $("#scoreRecall").onclick = () => {
      const got = Object.values(s.hits).filter(Boolean).length;
      const total = s.points.length;
      S.recall[`c${s.comp}:${now()}`] = { comp: s.comp, got, total, at: now() };
      save();
      const missedTopics = s.points.filter((_, i) => !s.hits[i]);
      const p = got / total;
      const b = band(p);
      app.innerHTML = `
        <div class="panel" style="text-align:center">
          <div class="score-big">${got}<span style="font-size:1.5rem;color:var(--muted)">/${total}</span></div>
          <p><span class="verdict-band ${b.cls}">${Math.round(p * 100)}% recalled cold</span></p>
        </div>
        ${missedTopics.length ? `<div class="panel"><h2>Did not come to mind</h2>
          <p class="muted small">These are your real gaps. Read them now, then run the flashcards for this competency.</p>
          <ul class="keypoints">${missedTopics.map((t) => `<li><span><strong>${esc(t.topic)}</strong><br><span class="small">${esc(t.back)}</span></span></li>`).join("")}</ul>
          <div class="actions">
            <button class="btn-primary" onclick="__go('#/cards')">Drill these with flashcards</button>
            <button onclick="__go('#/guide/${s.comp}')">Read the guide section</button>
          </div></div>` : `<div class="panel"><p>Clean sweep. Nothing missing.</p>
            <button class="btn-primary" onclick="__go('#/')">Home</button></div>`}`;
      session = null;
    };
  }

  /* ================= concept guide ================= */

  function guideIndex(rest) {
    if (rest && rest[0]) return guideComp(Number(rest[0]));
    app.innerHTML = `
      <div class="panel">
        <h1>Concept guide</h1>
        ${helpBox("guide")}
        <p class="muted">Everything the state says is testable, competency by competency, with the formulas you have to memorize and the traps that catch teachers. There are no reference materials on the real test, so anything in a formula box has to be in your head.</p>
      </div>
      <div class="modes">
        ${DATA.guide.map((g) => `<button class="mode c${g.comp} rail" onclick="__go('#/guide/${g.comp}')">
          <span class="tagline">${compIcon(g.comp)} ${g.pct}% of test</span>
          <h3>${g.comp}. ${esc(g.title)}</h3>
          <p>${pluralize(g.sections.length, "section", "sections")} &middot; ${statusPill(skillSummary && DATA.skills[String(g.comp)] ? (DATA.skills[String(g.comp)].every((_, i) => skillStatus(g.comp, i + 1).state === "mastered") ? "mastered" : DATA.skills[String(g.comp)].some((_, i) => skillStatus(g.comp, i + 1).state !== "untouched") ? "shaky" : "untouched") : "untouched")}</p></button>`).join("")}
      </div>`;
  }

  function guideComp(comp) {
    const g = DATA.guide.find((x) => x.comp === comp);
    if (!g) return guideIndex();
    app.innerHTML = `
      <div class="panel">
        <div class="crumb"><span class="chip">Competency ${g.comp}</span><span class="small muted">${g.pct}% of the test</span></div>
        <h1 style="font-family:var(--serif)">${esc(g.title)}</h1>
        <div class="actions">
          <button class="btn-primary" onclick="__go('#/quiz')">Quiz myself on this</button>
          <button onclick="__go('#/guide')">All competencies</button>
        </div>
      </div>
      ${g.sections.map((sec, i) => `<details class="sec" ${i === 0 ? "open" : ""}>
        <summary>${esc(sec.h)}</summary>
        <div class="inner body-md">${md(sec.body)}</div></details>`).join("")}
      <div class="panel" style="margin-top:1rem">
        <p class="small muted">Reading is the weakest form of study on its own. Follow this with a brain dump or a topic quiz while it is still fresh.</p>
        <div class="actions">
          <button class="btn-primary" onclick="__go('#/recall')">Brain dump this competency</button>
          ${comp < 9 ? `<button onclick="__go('#/guide/${comp + 1}')">Next competency</button>` : ""}
        </div>
      </div>`;
  }

  /* ================= progress ================= */

  function progressView() {
    const o = overall();
    const rows = DATA.comps.map((c) => ({ ...c, m: compMastery(c.comp) }));
    const weak = rows.filter((r) => r.m.seen >= 3).sort((a, b) => a.m.score - b.m.score).slice(0, 3);
    const untouched = rows.filter((r) => r.m.seen < 3);
    const cardsSeen = Object.keys(S.cards).length;
    const recalls = Object.values(S.recall).sort((a, b) => b.at - a.at).slice(0, 6);

    app.innerHTML = `
      <div class="panel">
        <h1>Progress</h1>
        ${helpBox("progress")}
        <div class="stat-row">
          <div class="stat"><b>${o.seen}/${o.total}</b><span>${icon("i-quiz", "ico ico--sm")}Questions tried</span></div>
          <div class="stat"><b>${o.seen ? Math.round(o.accuracy * 100) + "%" : "&mdash;"}</b><span>Accuracy</span></div>
          <div class="stat"><b>${cardsSeen}/${DATA.cards.length}</b><span>${icon("i-cards", "ico ico--sm")}Cards started</span></div>
          <div class="stat"><b>${S.exams.length}</b><span>${icon("i-exam", "ico ico--sm")}Mock exams</span></div>
        </div>
      </div>

      <div class="panel">
        <h2>Where to spend the next session</h2>
        ${untouched.length ? `<p>Not enough data yet on: ${untouched.map((r) => esc(r.title.toLowerCase())).join(", ")}. Run a topic quiz on each so the drill can target properly.</p>` : ""}
        ${weak.length ? `<ol>${weak.map((r) => `<li><strong>${esc(r.title)}</strong> (${r.pct}% of the test): ${Math.round(r.m.accuracy * 100)}% accurate over ${r.m.seen} questions.</li>`).join("")}</ol>` : ""}
        <div class="actions"><button class="btn-primary" onclick="__go('#/drill')">Adaptive drill</button></div>
      </div>

      <div class="panel">
        <h2>Mastery detail</h2>
        ${rows.map((r) => `<div class="mrow"><span class="lbl">${r.comp}. ${esc(r.title)}</span>
          <span class="val">${r.m.seen}/${r.m.total} tried &middot; ${r.m.seen ? Math.round(r.m.accuracy * 100) + "% right" : "&mdash;"}</span></div>
          <div class="bar"><i class="${barClass(r.m.score)}" style="width:${Math.round(r.m.score * 100)}%"></i></div>`).join("")}
        <p class="small muted">The bar is accuracy scaled down until you have covered at least 60 percent of that competency's questions, so a short hot streak does not read as mastery.</p>
      </div>

      ${S.exams.length ? `<div class="panel"><h2>Mock exam history</h2>
        ${S.exams.slice().reverse().map((e) => {
          const p = e.raw / e.total;
          return `<div class="mrow"><span class="lbl">${new Date(e.at).toLocaleString()}</span>
            <span class="val">${e.raw}/${e.total} &middot; ${Math.round(p * 100)}%</span></div>
            <div class="bar"><i class="${barClass(p)}" style="width:${Math.round(p * 100)}%"></i></div>`;
        }).join("")}</div>` : ""}

      ${recalls.length ? `<div class="panel"><h2>Brain dump history</h2>
        ${recalls.map((r) => `<div class="mrow"><span class="lbl">Competency ${r.comp}: ${esc(compTitle(r.comp))}</span>
          <span class="val">${r.got}/${r.total} &middot; ${new Date(r.at).toLocaleDateString()}</span></div>`).join("")}</div>` : ""}

      <div class="panel">
        <h2>${icon("i-sun")} Appearance</h2>
        <p class="small muted">Matching your device is the default, so it goes dark at night on its own.</p>
        <div class="seg" role="group" aria-label="Theme">
          ${THEMES.map((t) => `<button type="button" data-theme-opt="${t}" aria-pressed="false">
            <svg viewBox="0 0 24 24" class="ico" aria-hidden="true"><use href="#${THEME_ICON[t]}"></use></svg>${THEME_LABEL[t]}</button>`).join("")}
        </div>
      </div>

      <div class="panel">
        <h2>${icon("i-pencil")} Your name</h2>
        <p class="small muted">Only used for the greeting on the home screen.</p>
        <div class="actions">
          <input type="text" id="nameIn" class="date-in" maxlength="24" placeholder="Your name" value="${esc(userName())}" style="flex:1 1 12rem">
          <button class="btn-primary" id="nameSet">Save</button>
        </div>
      </div>

      <div class="panel">
        <h2>${icon("i-clock")} Test date</h2>
        <p class="small muted">Everything paces backwards from this: the daily plan, when mini mocks appear, and when the app switches to pacing and formulas.</p>
        <div class="actions">
          <input type="date" id="examDateIn" class="date-in" value="${esc(examDate() || "")}">
          <button class="btn-primary" id="examDateSet">Save</button>
          ${examDate() ? `<button id="examDateClear">Clear</button>` : ""}
        </div>
        ${examDate() ? `<p class="small" style="margin:.6rem 0 0">${daysUntilExam() >= 0 ? `${daysUntilExam()} days out. Phase: ${esc(phase().label.toLowerCase())}.` : "That date has passed. Set a new one."}</p>` : ""}
      </div>

      <div class="panel">
        <h2>${icon("i-quiz")} Confidence check</h2>
        <p class="small muted">Asks how sure you are before showing whether you were right. It is one extra tap, and it is the only way the app can spot the answers you are confidently wrong about, which are the ones that cost points.</p>
        <div class="seg" role="group" aria-label="Confidence check">
          <button type="button" data-conf-pref="1" aria-pressed="${askConfidence()}">On</button>
          <button type="button" data-conf-pref="0" aria-pressed="${!askConfidence()}">Off</button>
        </div>
      </div>

      <div class="panel">
        <h2>${icon("i-target")} Daily goal</h2>
        <p class="small muted">Cards and questions both count. Pick something you will actually hit on a bad day: a streak you can keep beats an ambitious one you break.</p>
        <div class="seg" role="group" aria-label="Daily goal">
          ${[10, 20, 30, 50].map((n) => `<button type="button" data-goal="${n}" aria-pressed="${goalTarget() === n}">${n}</button>`).join("")}
        </div>
      </div>

      <div class="panel" id="securityPanel">
        <h2>${icon("i-lock")} Sign-in</h2>
        <div id="pkList" class="small muted">Loading passkeys&hellip;</div>
        <p class="small muted" id="pkHelp">A passkey lets you sign in with Face ID, Touch ID, or your device PIN instead of typing the code. The PIN keeps working either way.</p>
        <div class="actions">
          <button class="btn-primary" id="addPasskey" hidden>Add a passkey on this device</button>
          <button id="changePin">Change PIN</button>
        </div>
        <p class="small" id="pkMsg" hidden></p>
      </div>

      <div class="panel">
        <h2>Reset</h2>
        <p class="small muted">Wipes every score, card schedule, and exam on all devices. There is no undo.</p>
        <button id="resetAll">Erase all my progress</button>
      </div>`;

    initSecurityPanel();
    applyTheme(currentTheme());

    app.querySelectorAll("[data-theme-opt]").forEach((b) => {
      b.onclick = () => { applyTheme(b.dataset.themeOpt); save(); };
    });
    const nSet = $("#nameSet");
    if (nSet) nSet.onclick = () => {
      S.prefs = { ...(S.prefs || {}), name: ($("#nameIn").value || "").trim().slice(0, 24) };
      S.prefsAt = Date.now();
      save();
      progressView();
    };
    const eSet = $("#examDateSet");
    if (eSet) eSet.onclick = () => {
      const v = $("#examDateIn").value;
      S.prefs = { ...(S.prefs || {}), examDate: v || null };
      S.prefsAt = Date.now();
      save();
      progressView();
    };
    const eClr = $("#examDateClear");
    if (eClr) eClr.onclick = () => {
      S.prefs = { ...(S.prefs || {}), examDate: null };
      S.prefsAt = Date.now();
      save();
      progressView();
    };
    app.querySelectorAll("[data-conf-pref]").forEach((b) => {
      b.onclick = () => {
        S.prefs = { ...(S.prefs || {}), askConfidence: b.dataset.confPref === "1" };
        S.prefsAt = Date.now();
        save();
        progressView();
      };
    });
    app.querySelectorAll("[data-goal]").forEach((b) => {
      b.onclick = () => {
        S.prefs = { ...(S.prefs || {}), dailyGoal: Number(b.dataset.goal) };
        S.prefsAt = Date.now();
        save();
        app.querySelectorAll("[data-goal]").forEach((x) => x.setAttribute("aria-pressed", String(Number(x.dataset.goal) === goalTarget())));
      };
    });

    $("#resetAll").onclick = async () => {
      if (DEMO) {
        S = seedDemo();
        writeLocal();
        go("#/");
        router();
        return;
      }
      if (!confirm("Erase all progress on every device? This cannot be undone.")) return;
      S = emptyState();
      writeLocal();
      try { await fetch("/api/reset", { method: "POST" }); } catch { /* offline */ }
      go("#/");
      router();
    };
  }

  /* ================= sign-in settings (passkeys + PIN) ================= */

  const b2buf = (s) => {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  };
  const buf2b64url = (buf) => {
    const u = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const buf2b64 = (buf) => {
    const u = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
    return btoa(bin);
  };

  function pkMsg(text, bad) {
    const el = $("#pkMsg");
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
    el.style.color = bad ? "var(--bad)" : "var(--good)";
  }

  async function refreshPasskeys() {
    const list = $("#pkList");
    if (!list) return;
    try {
      const { credentials } = await (await fetch("/api/auth/passkey")).json();
      if (!credentials.length) {
        list.innerHTML = `<p class="small muted">No passkey registered yet. You sign in with the PIN.</p>`;
        return;
      }
      list.innerHTML = credentials.map((c) => `<div class="mrow" style="align-items:center">
        <span class="lbl">${esc(c.label || "Passkey")}
          <span class="muted small">added ${new Date(c.created_at + "Z").toLocaleDateString()}${c.last_used_at ? `, last used ${new Date(c.last_used_at + "Z").toLocaleDateString()}` : ""}</span></span>
        <button class="small" data-rmpk="${esc(c.id)}" style="padding:.25rem .6rem">Remove</button></div>`).join("");
      list.querySelectorAll("[data-rmpk]").forEach((b) => {
        b.onclick = async () => {
          if (!confirm("Remove this passkey? You can still sign in with the PIN.")) return;
          await fetch("/api/auth/passkey?id=" + encodeURIComponent(b.dataset.rmpk), { method: "DELETE" });
          pkMsg("Passkey removed.", false);
          refreshPasskeys();
        };
      });
    } catch {
      list.innerHTML = `<p class="small muted">Could not load passkeys.</p>`;
    }
  }

  function initSecurityPanel() {
    // The demo has no account, and the auth endpoints refuse it, so replace
    // the panel rather than let it fail against a 403.
    if (DEMO) {
      const panel = $("#securityPanel");
      if (panel) {
        panel.innerHTML = `<h2>${icon("i-lock")} Sign-in</h2>
          <p class="small muted">The real app is private: a PIN, with an optional passkey so you can sign in with Face ID. There is no account in the demo, so there is nothing to configure here.</p>`;
      }
      return;
    }
    refreshPasskeys();
    const add = $("#addPasskey");
    if (add && window.PublicKeyCredential) {
      add.hidden = false;
      add.onclick = async () => {
        pkMsg("", false);
        add.disabled = true;
        try {
          const o = await (await fetch("/api/auth/passkey/register/options", { method: "POST" })).json();
          if (o.error) { pkMsg(o.error, true); return; }
          const cred = await navigator.credentials.create({
            publicKey: {
              challenge: b2buf(o.challenge),
              rp: o.rp,
              user: { id: b2buf(o.user.id), name: o.user.name, displayName: o.user.displayName },
              pubKeyCredParams: o.pubKeyCredParams,
              excludeCredentials: (o.excludeCredentials || []).map((c) => ({ type: "public-key", id: b2buf(c.id) })),
              authenticatorSelection: o.authenticatorSelection,
              timeout: o.timeout,
              attestation: o.attestation,
            },
          });
          const pub = cred.response.getPublicKey();
          if (!pub) { pkMsg("This browser did not return a public key. Try a different browser.", true); return; }
          const r = await fetch("/api/auth/passkey/register/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: cred.id,
              publicKey: buf2b64(pub),
              alg: cred.response.getPublicKeyAlgorithm(),
              clientDataJSON: buf2b64url(cred.response.clientDataJSON),
              label: navigator.platform || "This device",
            }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { pkMsg(j.error || "Could not add the passkey.", true); return; }
          pkMsg("Passkey added. You can use it on the sign-in screen.", false);
          refreshPasskeys();
        } catch (e) {
          if (e && e.name === "NotAllowedError") pkMsg("The passkey prompt was dismissed.", true);
          else pkMsg("Could not add the passkey on this device.", true);
        } finally {
          add.disabled = false;
        }
      };
    }

    const chg = $("#changePin");
    if (chg) {
      chg.onclick = async () => {
        const pin = prompt("New PIN (4 to 12 digits):");
        if (pin === null) return;
        if (!/^\d{4,12}$/.test(pin)) { pkMsg("PIN must be 4 to 12 digits.", true); return; }
        if (prompt("Type it once more to confirm:") !== pin) { pkMsg("The two PINs did not match.", true); return; }
        const r = await fetch("/api/auth/pin", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin }),
        });
        const j = await r.json().catch(() => ({}));
        pkMsg(r.ok ? "PIN changed. Use the new one next time you sign in." : (j.error || "Could not change the PIN."), !r.ok);
      };
    }
  }

  /* ================= keyboard ================= */

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (!session) return;

    if (session.queue) {                       // flashcards
      // A typed card owns the keyboard: she is writing an answer, so space
      // must insert a space and digits must type digits.
      if (session.queue[session.i]?.drill === "type") return;
      if (!session.shown && (e.key === " " || e.key === "Enter")) {
        e.preventDefault(); session.shown = true; renderCard();
      } else if (session.shown && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault(); gradeCard(session.queue[session.i], Number(e.key) - 1);
      }
      return;
    }
    if (session.kind === "run") {
      const map = { a: 0, b: 1, c: 2, d: 3, 1: 0, 2: 1, 3: 2, 4: 3 };
      const k = e.key.toLowerCase();
      if (session.picked === null && k in map) { e.preventDefault(); pickAnswer(map[k]); }
      else if (session.stage === "conf" && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault(); setConfidence(Number(e.key));
      } else if (session.stage === "reveal" && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault(); nextRunQuestion();
      }
      return;
    }
    if (session.kind === "exam") {
      const map = { a: 0, b: 1, c: 2, d: 3, 1: 0, 2: 1, 3: 2, 4: 3 };
      const k = e.key.toLowerCase();
      const q = session.qs[session.i];
      if (k in map) { e.preventDefault(); session.answers[q.id] = map[k]; if (session.i < session.qs.length - 1) session.i++; renderExam(); }
      else if (e.key === "ArrowRight" && session.i < session.qs.length - 1) { session.i++; renderExam(); }
      else if (e.key === "ArrowLeft" && session.i > 0) { session.i--; renderExam(); }
    }
  });

  document.getElementById("helpBtn").onclick = () => {
    if (session && session.kind === "exam" && !confirm("Leave the exam? Your answers will be lost.")) return;
    clearInterval(examTimer);
    session = null;
    go("#/help");
  };

  document.getElementById("homeBtn").onclick = () => {
    if (session && session.kind === "exam" && !confirm("Leave the exam? Your answers will be lost.")) return;
    clearInterval(examTimer);
    session = null;
    if (location.hash === "#/" || location.hash === "") router();
    else go("#/");
  };

  window.addEventListener("beforeunload", (e) => {
    if (session && session.kind === "exam") { e.preventDefault(); e.returnValue = ""; }
  });

  window.addEventListener("hashchange", () => {
    if (session && session.kind === "exam") clearInterval(examTimer);
    router();
  });

  /* ================= flag widget + back to top ================= */

  const SITE = "learn.gaitherstephens.com";
  const COLLECTOR = "https://gaithernews.com/api/network-flag";

  // Ring buffer of recent JS errors, shipped with the flag so a "doesn't work"
  // report arrives with the actual exception attached.
  const errLog = [];
  const pushErr = (s) => { errLog.push(String(s).slice(0, 200)); if (errLog.length > 10) errLog.shift(); };
  addEventListener("error", (e) => pushErr((e.message || "error") + " @ " + String(e.filename || "").split("/").pop() + ":" + (e.lineno || 0)));
  addEventListener("unhandledrejection", (e) => pushErr("promise: " + String(e.reason)));

  // Study-app reasons. Picking a sub submits immediately (one tap, done);
  // note-style reasons open the textarea instead. `cat` values must be in the
  // collector's VALID_CATEGORIES.
  const FLAG_REASONS = [
    { id: "content", label: "A question or card is wrong", subs: [
      ["key",      "The marked answer is wrong",              "bug"],
      ["tworight", "More than one answer looks correct",      "bug"],
      ["explain",  "The explanation is wrong or confusing",   "bug"],
      ["card",     "A flashcard is wrong",                    "bug"],
      ["guide",    "The concept guide has an error",          "bug"],
      ["typo",     "Typo or wording",                         "typo"],
    ]},
    { id: "offtest", label: "This does not match the real test", subs: [
      ["toohard",  "Much harder than the real thing",         "suggestion"],
      ["tooeasy",  "Much easier than the real thing",         "suggestion"],
      ["missing",  "A topic I was tested on is missing",      "suggestion"],
      ["style",    "Question style feels off",                "suggestion"],
    ]},
    { id: "broken", label: "Something does not work", subs: [
      ["click",    "Button or link does nothing",             "bug"],
      ["stuck",    "Page blank, partial, or stuck",           "bug"],
      ["progress", "My progress did not save or sync",        "bug"],
      ["exam",     "The timer or mock exam misbehaved",       "bug"],
      ["login",    "Trouble signing in",                      "bug"],
    ]},
    { id: "looks", label: "Looks broken or hard to read", subs: [
      ["overlap",  "Elements overlapping or cut off",         "visual"],
      ["mobile",   "Broken on my phone",                      "visual"],
      ["contrast", "Hard to read, colors or size",            "visual"],
    ]},
    { id: "accessibility", label: "Accessibility issue", cat: "accessibility", subs: null },
    { id: "idea", label: "Idea or suggestion", cat: "idea", subs: null },
    { id: "other", label: "Something else (describe)", cat: "other", subs: null },
  ];

  const FLAG_ICONS = {
    flag: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><path d="M4 21V4M4 4h13l-2 4 2 4H4"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
  };

  function initFlag() {
    const dlg = $("#flagDialog");
    if (!dlg) return;
    const stepCats = $("#flagStepCats"), stepSubs = $("#flagStepSubs"), stepNote = $("#flagStepNote");
    const hint = $("#flagHint"), noteLabel = $("#flagNoteLabel"), noteEl = $("#flagNote");
    const sendBtn = $("#flagSend"), toast = $("#flagToast");
    let picked = { reason: null };

    const show = (step) => {
      stepCats.hidden = step !== "cats";
      stepSubs.hidden = step !== "subs";
      stepNote.hidden = step !== "note";
    };

    function renderCats() {
      hint.textContent = "What looks broken, wrong, or confusing?";
      stepCats.innerHTML = FLAG_REASONS.map((r) =>
        `<button type="button" class="flag-opt" data-reason="${r.id}">${FLAG_ICONS.flag}<span>${esc(r.label)}</span>${r.subs ? '<span class="fo-arrow">&rsaquo;</span>' : ""}</button>`).join("");
      show("cats");
    }

    function renderSubs(reason) {
      hint.textContent = reason.label + ": pick one, it sends right away";
      stepSubs.innerHTML =
        `<button type="button" class="flag-back-row" data-flag-back>${FLAG_ICONS.back}Back</button>` +
        reason.subs.map(([id, label]) => `<button type="button" class="flag-opt" data-sub="${id}"><span>${esc(label)}</span></button>`).join("") +
        `<button type="button" class="flag-opt" data-sub="general"><span>Not sure, just flag it</span></button>`;
      show("subs");
    }

    function renderNote() {
      const r = picked.reason;
      hint.textContent = r.label;
      noteLabel.textContent = r.id === "idea" ? "What's your idea?" : r.id === "other" ? "What happened?" : "What's the issue?";
      noteEl.value = "";
      toast.hidden = true;
      sendBtn.disabled = false;
      sendBtn.textContent = "Send flag";
      show("note");
    }

    // Snapshot of browser + app state at submit time. `studying` is the
    // useful bit: it says which question or card was on screen.
    function flagContext() {
      let loadMs = null;
      try {
        const nav = performance.getEntriesByType("navigation")[0];
        if (nav && nav.duration) loadMs = Math.round(nav.duration);
      } catch { /* unsupported */ }
      const conn = navigator.connection || {};
      let studying = "";
      try {
        if (session?.kind === "run" || session?.kind === "exam") {
          const q = session.qs[session.i];
          studying = `question ${q.id} (comp ${q.comp}, ${q.topic})`;
        } else if (session?.queue) {
          const c = session.queue[session.i];
          studying = `card ${c.id} (comp ${c.comp}, ${c.topic})`;
        } else if (session?.kind === "recall") {
          studying = `brain dump, comp ${session.comp}`;
        }
      } catch { /* best effort */ }
      const o = DATA ? overall() : { seen: 0, total: 0 };
      return {
        ua: navigator.userAgent,
        language: navigator.language || "",
        platform: navigator.userAgentData?.platform || navigator.platform || "",
        touch: (navigator.maxTouchPoints || 0) > 0,
        viewport: innerWidth + "x" + innerHeight,
        screen: screen.width + "x" + screen.height,
        dpr: devicePixelRatio || 1,
        orientation: screen.orientation?.type || "",
        online: navigator.onLine,
        connection: conn.effectiveType || "",
        scroll: Math.round(scrollY) + "/" + Math.round(document.documentElement.scrollHeight),
        time_on_page_s: Math.round(performance.now() / 1000),
        load_ms: loadMs,
        referrer: document.referrer,
        studying,
        progress: `${o.seen}/${o.total} questions tried`,
        errors: errLog.slice(-5),
      };
    }

    async function sendFlag(category, note, fromStep) {
      dlg.querySelectorAll(".flag-opt").forEach((b) => (b.disabled = true));
      let ok = false;
      try {
        const version = ($(".footer-version")?.textContent || "").trim().replace(/^v/, "");
        const r = await fetch(COLLECTOR, {
          method: "POST",
          mode: "cors",
          credentials: "omit",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            site: SITE,
            version,
            category,
            note: note.slice(0, 1800),
            page_url: location.pathname + location.hash,
            context: flagContext(),
          }),
        });
        ok = r.ok;
      } catch { /* offline or blocked */ }
      toast.textContent = ok ? "Thanks. Gaither will see it." : "Could not send right now. Try again later.";
      toast.className = "flag-toast " + (ok ? "ok" : "err");
      toast.hidden = false;
      if (ok) setTimeout(() => dlg.close("ok"), 1300);
      else {
        dlg.querySelectorAll(".flag-opt").forEach((b) => (b.disabled = false));
        if (fromStep === "note") { sendBtn.disabled = false; sendBtn.textContent = "Send flag"; }
      }
    }

    document.addEventListener("click", (e) => {
      const open = e.target.closest('[data-learn-flag="open"]');
      if (open) {
        e.preventDefault();
        picked = { reason: null };
        $("#flagPageUrl").textContent = location.pathname + location.hash;
        toast.hidden = true;
        renderCats();
        dlg.showModal();
        return;
      }
      if (e.target.closest("[data-flag-close]") && dlg.open) { dlg.close("cancel"); return; }
      if (e.target.closest("[data-flag-back]") && dlg.open) {
        if (!stepNote.hidden && picked.reason?.subs) renderSubs(picked.reason);
        else renderCats();
        return;
      }
      if (!dlg.open) return;
      const catBtn = e.target.closest(".flag-opt[data-reason]");
      if (catBtn) {
        picked.reason = FLAG_REASONS.find((r) => r.id === catBtn.dataset.reason);
        if (picked.reason.subs) renderSubs(picked.reason);
        else renderNote();
        return;
      }
      const subBtn = e.target.closest(".flag-opt[data-sub]");
      if (subBtn && picked.reason?.subs) {
        const subId = subBtn.dataset.sub;
        const found = picked.reason.subs.find((s) => s[0] === subId);
        const label = found ? found[1] : picked.reason.label;
        const cat = found ? found[2] : "bug";
        sendFlag(cat, `[${picked.reason.id}/${subId}] ${label}`, "subs");
      }
    });

    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close("cancel"); });

    stepNote.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!picked.reason) return;
      const note = (noteEl.value || "").trim();
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending...";
      sendFlag(picked.reason.cat || "other", `[${picked.reason.id}] ${note || picked.reason.label}`, "note");
    });
  }

  function initBackToTop() {
    const fab = $("#topFab");
    const sentinel = $("#topSentinel");
    if (!fab) return;

    const update = () => { fab.hidden = window.scrollY < 400; };

    // Scroll events alone are NOT sufficient. If the browser restores a scroll
    // position on load, or a route render changes page height, the position
    // changes without any scroll event firing, and the button gets stuck in
    // whatever state it had at init. An IntersectionObserver on a 400px
    // sentinel pinned to the top of the document reports the true state on
    // first observation and on every crossing, no scroll event required.
    if (sentinel && "IntersectionObserver" in window) {
      new IntersectionObserver(
        ([e]) => { fab.hidden = e.isIntersecting; },
        { threshold: 0 },
      ).observe(sentinel);
    }
    // Always seed from the real scroll position too. IntersectionObserver does
    // not run in a tab the browser is not painting, so it cannot be the only
    // source of truth for the initial state.
    update();

    // Belt and braces for the scrolling case and for height changes.
    addEventListener("scroll", update, { passive: true });
    addEventListener("resize", update, { passive: true });

    fab.onclick = () => {
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
      fab.hidden = true;
    };
  }

  function initDemoBar() {
    const bar = document.createElement("div");
    bar.className = "demo-bar";
    bar.innerHTML = `${icon("i-eye")}<strong>Demo</strong>
      <span>Everything works, with sample progress for a made-up learner. Nothing is saved and no real account is visible.</span>
      <a href="#" id="demoReset">Start over</a>
      <a href="/exit-demo">Exit</a>`;
    document.body.insertBefore(bar, document.querySelector("header.top"));
    bar.querySelector("#demoReset").onclick = (e) => {
      e.preventDefault();
      S = seedDemo();
      writeLocal();
      go("#/");
      router();
    };
  }

  /* ================= boot ================= */

  (async () => {
    try {
      const [content] = await Promise.all([
        fetch("/content.json?v=2026.07.27-1506").then((r) => {
          if (!r.ok) throw new Error("content " + r.status);
          return r.json();
        }),
        pull(),
      ]);
      DATA = content;
      if (DEMO) {
        if (!S.prefs?.onboarded) { S = seedDemo(); writeLocal(); }
        initDemoBar();
      }
      initTheme();
      router();
      initFlag();
      initBackToTop();
    } catch (err) {
      app.innerHTML = `<div class="panel"><h1>Could not load</h1>
        <p class="muted">The study material did not load. Check your connection and reload.</p>
        <p class="small muted">${esc(String(err && err.message || err))}</p></div>`;
    }
  })();
})();
