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

  const emptyState = () => ({ cards: {}, questions: {}, exams: [], recall: {}, prefs: {}, prefsAt: 0, updatedAt: 0 });

  function loadLocal() {
    try { return { ...emptyState(), ...JSON.parse(localStorage.getItem(LS_KEY) || "{}") }; }
    catch { return emptyState(); }
  }

  function writeLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch { /* quota */ }
  }

  function setSync(cls, title) {
    syncDot.className = "sync-dot " + cls;
    syncDot.title = title;
  }

  /* Push to the server, debounced. Server merges per record by timestamp and
     returns the merged truth, so a stale device cannot wipe the other's work. */
  function save() {
    S.updatedAt = Date.now();
    writeLocal();
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
      const server = { ...emptyState(), ...(await res.json()) };
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
      S = {
        cards: mergeRec(server.cards, local.cards),
        questions: mergeRec(server.questions, local.questions),
        recall: mergeRec(server.recall, local.recall),
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
    "guide": guideIndex,
    "recall": recallSetup,
    "missed": missedStart,
    "progress": progressView,
  };

  function go(hash) { location.hash = hash; }

  function router() {
    const raw = (location.hash || "#/").replace(/^#\/?/, "");
    const [head, ...rest] = raw.split("/");
    const fn = routes[head] || home;
    window.scrollTo(0, 0);
    fn(rest);
  }

  /* ================= home ================= */

  function home() {
    session = null;
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

    app.innerHTML = `
      <section class="hero">
        <h1>Middle Grades General Science 5&ndash;9</h1>
        <p class="muted" style="margin-bottom:0">80 questions &middot; 2 hours 30 minutes &middot; scaled score 200 to pass</p>
        <div class="stat-row">
          <div class="stat"><b>${o.seen}<span style="font-size:1rem;color:var(--muted)">/${o.total}</span></b><span>Questions tried</span></div>
          <div class="stat"><b>${o.seen ? Math.round(o.accuracy * 100) + "%" : "&mdash;"}</b><span>Current accuracy</span></div>
          <div class="stat"><b>${due}</b><span>Cards due</span></div>
          <div class="stat"><b>${lastExam ? Math.round((lastExam.raw / lastExam.total) * 100) + "%" : "&mdash;"}</b><span>Last mock exam</span></div>
        </div>
        <p style="margin:1rem 0 0;padding-top:1rem;border-top:1px solid var(--line);font-size:.92rem"><strong>Next:</strong> ${esc(nudge)}</p>
      </section>

      <h2>Ways to study</h2>
      <div class="modes">
        <button class="mode" onclick="location.hash='#/cards'">
          <span class="tagline">Spaced repetition</span>
          <h3>Flashcards</h3>
          <p>300 cards on a Leitner schedule. Cards you miss come back fast, cards you know go quiet.</p>
          ${due ? `<span class="badge">${due} due now</span>` : ""}
        </button>
        <button class="mode" onclick="location.hash='#/quiz'">
          <span class="tagline">Retrieval practice</span>
          <h3>Topic quiz</h3>
          <p>Pick one competency and answer questions with an explanation after every single one.</p>
        </button>
        <button class="mode" onclick="location.hash='#/drill'">
          <span class="tagline">Interleaving</span>
          <h3>Adaptive drill</h3>
          <p>Twenty mixed questions, weighted toward your weak competencies and things you got wrong before.</p>
        </button>
        <button class="mode" onclick="location.hash='#/exam'">
          <span class="tagline">Test simulation</span>
          <h3>Mock exam</h3>
          <p>Eighty questions on the real blueprint, on a 2:30 clock, no feedback until you submit.</p>
        </button>
        <button class="mode" onclick="location.hash='#/recall'">
          <span class="tagline">Free recall</span>
          <h3>Brain dump</h3>
          <p>Write everything you know about a topic from memory, then check yourself against the key points.</p>
        </button>
        <button class="mode" onclick="location.hash='#/guide'">
          <span class="tagline">Reference</span>
          <h3>Concept guide</h3>
          <p>Every competency explained, with the formulas you have to memorize and the traps that catch people.</p>
        </button>
        <button class="mode" onclick="location.hash='#/missed'">
          <span class="tagline">Error log</span>
          <h3>Missed queue</h3>
          <p>Only the questions you have gotten wrong. They leave the queue when you get them right.</p>
          ${missed ? `<span class="badge">${missed} waiting</span>` : ""}
        </button>
        <button class="mode" onclick="location.hash='#/progress'">
          <span class="tagline">Diagnostics</span>
          <h3>Progress</h3>
          <p>Mastery by competency, exam history, and what to spend your next session on.</p>
        </button>
      </div>

      <div class="mastery">
        <h2>Mastery by competency</h2>
        ${DATA.comps.map((c) => {
          const m = compMastery(c.comp);
          const pct = Math.round(m.score * 100);
          return `<div class="mrow"><span class="lbl">${c.comp}. ${esc(c.title)}</span>
            <span class="val">${m.seen ? pct + "%" : "not started"} &middot; ${c.pct}% of test</span></div>
            <div class="bar"><i class="${barClass(m.score)}" style="width:${Math.max(pct, m.seen ? 2 : 0)}%"></i></div>`;
        }).join("")}
      </div>`;
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
          <button onclick="location.hash='#/'">Back</button>
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

    app.innerHTML = `
      <div class="panel">
        <div class="crumb">
          <span class="chip">Comp ${c.comp}</span>
          <span class="small muted">${esc(c.topic)}</span>
          <span class="prog">${s.i + 1} of ${total}${rec ? ` &middot; box ${rec.box}` : " &middot; new"}</span>
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
            <button data-g="0">Blank<small>see again now</small></button>
            <button data-g="1">Shaky<small>tomorrow</small></button>
            <button data-g="2">Got it<small>few days</small></button>
            <button data-g="3">Easy<small>next week+</small></button>
          </div>`
        : `<div class="actions"><button class="btn-primary" id="reveal">Show answer</button>
             <button onclick="location.hash='#/'">Stop</button></div>`}
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

  function gradeCard(card, grade) {
    const s = session;
    const prev = S.cards[card.id] || { box: 0, seen: 0 };
    let box;
    if (grade === 0) box = 0;
    else if (grade === 1) box = Math.max(1, prev.box);
    else if (grade === 2) box = Math.min(BOXES.length - 1, prev.box + 1);
    else box = Math.min(BOXES.length - 1, prev.box + 2);

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
          <button class="btn-primary" onclick="location.hash='#/cards'">Another deck</button>
          <button onclick="location.hash='#/'">Home</button>
        </div>
      </div>`;
    session = null;
  }

  /* ================= quiz / drill / missed (shared engine) ================= */

  function startQuestionRun(questions, label, opts = {}) {
    if (!questions.length) {
      app.innerHTML = `<div class="panel"><h1>Nothing to do</h1><p class="muted">No questions match that.</p>
        <button class="btn-primary" onclick="location.hash='#/'">Home</button></div>`;
      return;
    }
    session = { kind: "run", label, qs: questions, i: 0, picked: null, right: 0, opts };
    renderRunQuestion();
  }

  function renderRunQuestion() {
    const s = session;
    if (s.i >= s.qs.length) return runDone();
    const q = s.qs[s.i];
    // Shuffle choices per presentation so she learns the science, not the shape.
    if (!q._order) {
      q._order = shuffle(q.choices.map((_, idx) => idx));
    }
    const order = q._order;
    const answered = s.picked !== null;
    const correctPos = order.indexOf(q.answer);

    app.innerHTML = `
      <div class="panel">
        <div class="crumb">
          <span class="chip">Comp ${q.comp}</span>
          <span class="small muted">${esc(q.topic)}</span>
          <span class="prog">${s.i + 1} of ${s.qs.length} &middot; ${s.right} right</span>
        </div>
        <p class="stem">${esc(q.stem)}</p>
        <div class="choices">
          ${order.map((origIdx, pos) => {
            let cls = "choice";
            if (answered && pos === correctPos) cls += " correct";
            else if (answered && pos === s.picked) cls += " wrong";
            return `<button class="${cls}" data-pos="${pos}" ${answered ? "disabled" : ""}>
              <span class="key">${"ABCD"[pos]}</span><span>${esc(q.choices[origIdx])}</span></button>`;
          }).join("")}
        </div>
        ${answered ? `
          <p class="verdict ${s.picked === correctPos ? "ok" : "no"}">${s.picked === correctPos ? "Correct" : "Not quite"}</p>
          <div class="explain">${esc(q.explanation)}</div>
          <div class="actions">
            <button class="btn-primary" id="next">${s.i + 1 >= s.qs.length ? "See results" : "Next question"}</button>
            <button onclick="location.hash='#/'">Stop here</button>
          </div>`
        : `<p class="small muted">Keys A-D or 1-4 to answer</p>`}
      </div>`;

    if (!answered) {
      app.querySelectorAll(".choice").forEach((b) => {
        b.onclick = () => answerRun(Number(b.dataset.pos));
      });
    } else {
      $("#next").onclick = () => { s.i++; s.picked = null; renderRunQuestion(); };
    }
  }

  function answerRun(pos) {
    const s = session;
    const q = s.qs[s.i];
    const correct = q._order[pos] === q.answer;
    s.picked = pos;
    if (correct) s.right++;
    recordQuestion(q, correct);
    save();
    renderRunQuestion();
  }

  function recordQuestion(q, correct) {
    const prev = S.questions[q.id] || { seen: 0, correct: 0, wrong: 0 };
    S.questions[q.id] = {
      seen: prev.seen + 1,
      correct: prev.correct + (correct ? 1 : 0),
      wrong: prev.wrong + (correct ? 0 : 1),
      lastCorrect: correct,
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
    app.innerHTML = `
      <div class="panel" style="text-align:center">
        <p class="small muted" style="margin-bottom:.3rem">${esc(s.label)}</p>
        <div class="score-big">${s.right}<span style="font-size:1.5rem;color:var(--muted)">/${s.qs.length}</span></div>
        <p><span class="verdict-band ${b.cls}">${pct}% &middot; ${b.label}</span></p>
      </div>
      <div class="panel">
        <h2>By competency</h2>
        ${Object.entries(byComp).sort((a, b2) => a[0] - b2[0]).map(([c, v]) => {
          const p = v.r / v.n;
          return `<div class="mrow"><span class="lbl">${c}. ${esc(compTitle(Number(c)))}</span><span class="val">${v.r}/${v.n}</span></div>
            <div class="bar"><i class="${barClass(p)}" style="width:${Math.round(p * 100)}%"></i></div>`;
        }).join("")}
        <div class="actions" style="margin-top:1rem">
          ${missedQuestions().length ? `<button class="btn-primary" onclick="location.hash='#/missed'">Review what you missed</button>` : ""}
          <button onclick="location.hash='#/'">Home</button>
        </div>
      </div>`;
    session = null;
  }

  /* ---- quiz setup ---- */

  function quizSetup() {
    app.innerHTML = `
      <div class="panel">
        <h1>Topic quiz</h1>
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
        <label class="small muted" style="display:block;margin-bottom:.6rem">Length
          <select id="qlen" style="font:inherit;margin-left:.5rem;padding:.3rem;border-radius:8px;background:var(--bg);color:var(--fg);border:1px solid var(--line-strong)">
            <option value="10">10 questions</option>
            <option value="15" selected>15 questions</option>
            <option value="25">25 questions</option>
            <option value="999">Everything in this competency</option>
          </select></label>
        <label class="small muted" style="display:block;margin-bottom:1rem">
          <input type="checkbox" id="qfresh" style="accent-color:var(--cyan)"> Prefer questions I have not seen yet</label>
        <div class="actions">
          <button class="btn-primary" id="startQuiz">Start quiz</button>
          <button onclick="location.hash='#/'">Back</button>
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

  function drillStart() {
    /* Weight each competency by (its share of the test) x (how much you are missing it).
       Then interleave: the mix is deliberately jumbled rather than blocked by topic,
       because blocked practice feels easier and retains worse. */
    const N = 20;
    const weights = DATA.comps.map((c) => {
      const m = compMastery(c.comp);
      const gap = m.seen >= 3 ? 1 - m.score : 0.65;   // unknown areas get a middling default
      return { comp: c.comp, w: (c.pct / 100) * (0.25 + 1.75 * gap) };
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
    startQuestionRun(shuffle(picked).slice(0, N), "Adaptive drill: weighted to your weak spots");
  }

  /* ---- missed queue ---- */

  function missedStart() {
    const missed = missedQuestions();
    if (!missed.length) {
      app.innerHTML = `<div class="panel" style="text-align:center"><h1>Queue is empty</h1>
        <p class="muted">Nothing you have missed is still outstanding. That is a good place to be.</p>
        <div class="actions" style="justify-content:center">
          <button class="btn-primary" onclick="location.hash='#/drill'">Run a drill instead</button>
          <button onclick="location.hash='#/'">Home</button></div></div>`;
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
        <p class="muted">Eighty questions drawn on the real blueprint, 2 hours 30 minutes on the clock, no feedback until you submit. Sit it the way you would sit the real thing: one go, no notes, no phone.</p>
        <table class="body-md" style="font-size:.85rem;margin-bottom:1rem"><thead><tr><th>Competency</th><th>Items</th></tr></thead><tbody>
          ${DATA.comps.map((c) => `<tr><td>${c.comp}. ${esc(c.title)}</td><td>${BLUEPRINT[c.comp]}</td></tr>`).join("")}
        </tbody></table>
        <div class="actions">
          <button class="btn-primary" id="startExam">Begin timed exam</button>
          <button onclick="location.hash='#/'">Back</button>
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
      b.onclick = () => { s.answers[q.id] = Number(b.dataset.pos); if (s.i < s.qs.length - 1) s.i++; renderExam(); };
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
      if (pos !== undefined) recordQuestion(q, correct);
    }
    const minutes = Math.round((now() - s.started) / 60000);
    S.exams.push({ at: now(), raw, total: s.qs.length, minutes, byComp });
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
        <p class="small muted">Finished in ${minutes} of ${EXAM_MINUTES} minutes.</p>
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
          <button onclick="location.hash='#/'">Home</button>
        </div>
      </div>`;

    const w = wrong.slice();
    $("#reviewWrong").onclick = () => startQuestionRun(w, "Exam review: questions you missed");
    session = null;
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
        <p class="muted">Pick a competency, close everything else, and write down every single thing you can remember about it. Then check yourself against the key points. Pulling knowledge out cold is harder than rereading and that is exactly why it works better.</p>
        <div class="opts">
          ${compList.map((c) => `<label class="opt"><input type="radio" name="rc" value="${c.comp}" ${c.comp === 1 ? "checked" : ""}>
            <span>${c.comp}. ${esc(c.title)}</span>
            <span class="meta">${c.last ? "last: " + new Date(c.last).toLocaleDateString() : "never"}</span></label>`).join("")}
        </div>
        <div class="actions">
          <button class="btn-primary" id="startRecall">Start</button>
          <button onclick="location.hash='#/'">Back</button>
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
          <h2>Write down everything you know</h2>
          <p class="muted small">Formulas, definitions, examples, the order of things. Do not look anything up. Messy is fine, blank is information too.</p>
          <textarea class="recall" id="dump" placeholder="Start typing..."></textarea>
          <div class="actions" style="margin-top:.8rem">
            <button class="btn-primary" id="doneWriting">I am done, show the key points</button>
            <button onclick="location.hash='#/'">Stop</button>
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
            <button class="btn-primary" onclick="location.hash='#/cards'">Drill these with flashcards</button>
            <button onclick="location.hash='#/guide/${s.comp}'">Read the guide section</button>
          </div></div>` : `<div class="panel"><p>Clean sweep. Nothing missing.</p>
            <button class="btn-primary" onclick="location.hash='#/'">Home</button></div>`}`;
      session = null;
    };
  }

  /* ================= concept guide ================= */

  function guideIndex(rest) {
    if (rest && rest[0]) return guideComp(Number(rest[0]));
    app.innerHTML = `
      <div class="panel">
        <h1>Concept guide</h1>
        <p class="muted">Everything the state says is testable, competency by competency, with the formulas you have to memorize and the traps that catch teachers. There are no reference materials on the real test, so anything in a formula box has to be in your head.</p>
      </div>
      <div class="modes">
        ${DATA.guide.map((g) => `<button class="mode" onclick="location.hash='#/guide/${g.comp}'">
          <span class="tagline">${g.pct}% of test</span>
          <h3>${g.comp}. ${esc(g.title)}</h3>
          <p>${pluralize(g.sections.length, "section", "sections")}</p></button>`).join("")}
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
          <button class="btn-primary" onclick="location.hash='#/quiz'">Quiz myself on this</button>
          <button onclick="location.hash='#/guide'">All competencies</button>
        </div>
      </div>
      ${g.sections.map((sec, i) => `<details class="sec" ${i === 0 ? "open" : ""}>
        <summary>${esc(sec.h)}</summary>
        <div class="inner body-md">${md(sec.body)}</div></details>`).join("")}
      <div class="panel" style="margin-top:1rem">
        <p class="small muted">Reading is the weakest form of study on its own. Follow this with a brain dump or a topic quiz while it is still fresh.</p>
        <div class="actions">
          <button class="btn-primary" onclick="location.hash='#/recall'">Brain dump this competency</button>
          ${comp < 9 ? `<button onclick="location.hash='#/guide/${comp + 1}'">Next competency</button>` : ""}
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
        <div class="stat-row">
          <div class="stat"><b>${o.seen}/${o.total}</b><span>Questions tried</span></div>
          <div class="stat"><b>${o.seen ? Math.round(o.accuracy * 100) + "%" : "&mdash;"}</b><span>Accuracy</span></div>
          <div class="stat"><b>${cardsSeen}/${DATA.cards.length}</b><span>Cards started</span></div>
          <div class="stat"><b>${S.exams.length}</b><span>Mock exams</span></div>
        </div>
      </div>

      <div class="panel">
        <h2>Where to spend the next session</h2>
        ${untouched.length ? `<p>Not enough data yet on: ${untouched.map((r) => esc(r.title.toLowerCase())).join(", ")}. Run a topic quiz on each so the drill can target properly.</p>` : ""}
        ${weak.length ? `<ol>${weak.map((r) => `<li><strong>${esc(r.title)}</strong> (${r.pct}% of the test): ${Math.round(r.m.accuracy * 100)}% accurate over ${r.m.seen} questions.</li>`).join("")}</ol>` : ""}
        <div class="actions"><button class="btn-primary" onclick="location.hash='#/drill'">Adaptive drill</button></div>
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

      <div class="panel" id="securityPanel">
        <h2>Sign-in</h2>
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

    $("#resetAll").onclick = async () => {
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
      if (session.picked === null && k in map) { e.preventDefault(); answerRun(map[k]); }
      else if (session.picked !== null && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault(); session.i++; session.picked = null; renderRunQuestion();
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

  /* ================= boot ================= */

  (async () => {
    try {
      const [content] = await Promise.all([
        fetch("/content.json?v=2026.07.27-1329").then((r) => {
          if (!r.ok) throw new Error("content " + r.status);
          return r.json();
        }),
        pull(),
      ]);
      DATA = content;
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
