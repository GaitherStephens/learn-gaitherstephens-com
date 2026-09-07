/*
 * Network feedback flag modal.
 *
 * Used on every Gaither network site. Reads its config from a
 *   <script id="gd-flag-config" type="application/json">{"site":"X","version":"Y"}</script>
 * block that the site's layout injects. Triggered by any element with
 *   data-gd-flag="open"
 * in the footer (the version string button). POSTs to gaithernews.com.
 *
 * Pure vanilla JS, no framework, no build step. ~3 KB.
 */
(function () {
  "use strict";

  // Ring buffer of recent JS errors — shipped with the flag's context
  // snapshot so bug reports arrive with the actual exception attached.
  if (!window.__gdErrLog) {
    window.__gdErrLog = [];
    var pushErr = function (s) {
      window.__gdErrLog.push(String(s).slice(0, 200));
      if (window.__gdErrLog.length > 10) window.__gdErrLog.shift();
    };
    addEventListener("error", function (e) {
      pushErr((e.message || "error") + " @ " + String(e.filename || "").split("/").pop() + ":" + (e.lineno || 0));
    });
    addEventListener("unhandledrejection", function (e) {
      pushErr("promise: " + String(e.reason));
    });
  }

  var configEl = document.getElementById("gd-flag-config");
  if (!configEl) return;
  var cfg = {};
  try { cfg = JSON.parse(configEl.textContent || "{}"); } catch (_) { return; }
  var SITE = String(cfg.site || "").toLowerCase();
  var VERSION = String(cfg.version || "");
  if (!SITE) return;

  var API_URL = "https://gaithernews.com/api/network-flag";

  var CATEGORIES = [
    { value: "bug",   label: "Something is broken" },
    { value: "typo",  label: "Wrong or missing info" },
    { value: "idea",  label: "Idea or suggestion" },
    { value: "other", label: "Something else" },
  ];

  // Render the modal once on first open, keep around for repeat use.
  var modal = null;
  var photoDataUrl = null;
  function buildModal() {
    if (!document.getElementById("gd-flag-photo-style")) {
      var st = document.createElement("style");
      st.id = "gd-flag-photo-style";
      st.textContent = ".gd-flag-photo{margin:10px 0}.gd-flag-photo-btn{font:inherit;cursor:pointer;border:1px solid currentColor;background:transparent;color:inherit;border-radius:6px;padding:7px 12px;opacity:.85}.gd-flag-photo-btn:hover{opacity:1}.gd-flag-photo-preview{position:relative;display:inline-block;margin-top:8px}.gd-flag-photo-preview[hidden]{display:none}.gd-flag-photo-preview img{max-width:160px;max-height:120px;border-radius:8px;display:block}.gd-flag-photo-remove{position:absolute;top:-8px;right:-8px;width:22px;height:22px;border-radius:50%;border:none;background:#c23b5e;color:#fff;cursor:pointer;font-size:15px;line-height:1}";
      document.head.appendChild(st);
    }
    var wrap = document.createElement("div");
    wrap.className = "gd-flag-wrap";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "gd-flag-title");
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="gd-flag-backdrop" data-gd-flag-close></div>' +
      '<div class="gd-flag-panel">' +
        '<button type="button" class="gd-flag-x" data-gd-flag-close aria-label="Close">&times;</button>' +
        '<h2 id="gd-flag-title">Found a problem?</h2>' +
        '<p class="gd-flag-sub">Tell us what is broken so we can fix it. No account required.</p>' +
        '<form class="gd-flag-form">' +
          '<p class="gd-flag-meta">' +
            '<span>Page:</span> <code class="gd-flag-url"></code>' +
          '</p>' +
          '<fieldset class="gd-flag-cats">' +
            '<legend>What is wrong?</legend>' +
            CATEGORIES.map(function (c, i) {
              return '<label class="gd-flag-cat">' +
                '<input type="radio" name="category" value="' + c.value + '"' +
                  (i === 0 ? ' required' : '') + '> ' +
                '<span>' + c.label + '</span>' +
              '</label>';
            }).join("") +
          '</fieldset>' +
          '<label class="gd-flag-note-wrap">' +
            '<span>Optional note (max 2000 chars)</span>' +
            '<textarea name="note" rows="3" maxlength="2000" placeholder="Anything else that would help?"></textarea>' +
          '</label>' +
          '<div class="gd-flag-photo">' +
            '<button type="button" class="gd-flag-photo-btn">Add a photo (optional)</button>' +
            '<input type="file" class="gd-flag-photo-file" accept="image/*" hidden>' +
            '<div class="gd-flag-photo-preview" hidden>' +
              '<img class="gd-flag-photo-img" alt="Attached photo preview">' +
              '<button type="button" class="gd-flag-photo-remove" aria-label="Remove photo">&times;</button>' +
            '</div>' +
          '</div>' +
          '<div class="gd-flag-actions">' +
            '<button type="button" class="gd-flag-cancel" data-gd-flag-close>Cancel</button>' +
            '<button type="submit" class="gd-flag-send">Send</button>' +
          '</div>' +
        '</form>' +
        '<div class="gd-flag-toast" hidden></div>' +
      '</div>';
    document.body.appendChild(wrap);

    // Close handlers (backdrop click, X, Cancel, Escape).
    wrap.addEventListener("click", function (e) {
      if (e.target.hasAttribute("data-gd-flag-close")) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !wrap.hidden) closeModal();
    });

    // Submit handler.
    var form = wrap.querySelector(".gd-flag-form");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      submitFlag(form);
    });

    // Optional photo: picked from camera/library, downscaled in-browser to
    // <=1280px JPEG so the upload stays small (same as the recipes widget).
    var photoBtn = wrap.querySelector(".gd-flag-photo-btn");
    var photoFile = wrap.querySelector(".gd-flag-photo-file");
    var photoPrev = wrap.querySelector(".gd-flag-photo-preview");
    var photoImg = wrap.querySelector(".gd-flag-photo-img");
    var photoRemove = wrap.querySelector(".gd-flag-photo-remove");
    photoBtn.addEventListener("click", function () { photoFile.click(); });
    photoRemove.addEventListener("click", function () {
      photoDataUrl = null; photoPrev.hidden = true; photoImg.removeAttribute("src");
      photoFile.value = ""; photoBtn.hidden = false;
    });
    photoFile.addEventListener("change", function () {
      var f = photoFile.files && photoFile.files[0];
      if (!f || !/^image\//.test(f.type)) return;
      var img = new Image();
      var url = URL.createObjectURL(f);
      img.onload = function () {
        URL.revokeObjectURL(url);
        var MAX = 1280;
        var scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
        var cnv = document.createElement("canvas");
        cnv.width = Math.round(img.naturalWidth * scale);
        cnv.height = Math.round(img.naturalHeight * scale);
        cnv.getContext("2d").drawImage(img, 0, 0, cnv.width, cnv.height);
        photoDataUrl = cnv.toDataURL("image/jpeg", 0.82);
        photoImg.src = photoDataUrl; photoPrev.hidden = false; photoBtn.hidden = true;
      };
      img.onerror = function () { URL.revokeObjectURL(url); };
      img.src = url;
    });

    return wrap;
  }

  function openModal() {
    if (!modal) modal = buildModal();
    modal.querySelector(".gd-flag-url").textContent = location.pathname + location.search;
    modal.querySelector(".gd-flag-toast").hidden = true;
    var form = modal.querySelector(".gd-flag-form");
    form.reset();
    photoDataUrl = null;
    var _pp = modal.querySelector(".gd-flag-photo-preview"); if (_pp) _pp.hidden = true;
    var _pb = modal.querySelector(".gd-flag-photo-btn"); if (_pb) _pb.hidden = false;
    var _pf = modal.querySelector(".gd-flag-photo-file"); if (_pf) _pf.value = "";
    form.querySelector(".gd-flag-send").disabled = false;
    modal.hidden = false;
    document.documentElement.classList.add("gd-flag-open");
    setTimeout(function () {
      var first = modal.querySelector('input[name="category"]');
      if (first) first.focus();
    }, 40);
  }

  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    document.documentElement.classList.remove("gd-flag-open");
  }

  // Snapshot of browser + site state at submit time: device class, theme
  // actually active, connection quality, scroll depth, time on page, page
  // load time, and recent JS errors. Whitelisted + capped by the collector.
  function flagContext() {
    var loadMs = null;
    try {
      var nav = performance.getEntriesByType("navigation")[0];
      if (nav && nav.duration) loadMs = Math.round(nav.duration);
    } catch (_) {}
    var conn = navigator.connection || {};
    var doc = document.documentElement;
    return {
      ua: navigator.userAgent,
      language: navigator.language || "",
      platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "",
      touch: (navigator.maxTouchPoints || 0) > 0,
      viewport: innerWidth + "x" + innerHeight,
      screen: screen.width + "x" + screen.height,
      dpr: devicePixelRatio || 1,
      orientation: (screen.orientation && screen.orientation.type) || "",
      theme: doc.getAttribute("data-theme") || (doc.classList.contains("dark") ? "dark" : ""),
      view_mode: doc.getAttribute("data-view-mode") || "",
      online: navigator.onLine,
      connection: conn.effectiveType || "",
      scroll: Math.round(scrollY) + "/" + Math.round(doc.scrollHeight),
      time_on_page_s: Math.round(performance.now() / 1000),
      load_ms: loadMs,
      referrer: document.referrer,
      errors: (window.__gdErrLog || []).slice(-5),
    };
  }

  function submitFlag(form) {
    var fd = new FormData(form);
    var category = fd.get("category");
    var note = (fd.get("note") || "").toString();
    var send = form.querySelector(".gd-flag-send");
    var toast = modal.querySelector(".gd-flag-toast");
    if (!category) return;

    send.disabled = true;
    send.textContent = "Sending...";

    var payload = {
      site: SITE,
      version: VERSION,
      page_url: location.pathname + location.search,
      category: String(category),
      note: note,
      context: flagContext(),
    };
    if (photoDataUrl) payload.image = photoDataUrl;

    fetch(API_URL, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (resp) {
        if (resp && resp.ok) {
          toast.textContent = resp.deduped
            ? "Already received this one. Thanks anyway."
            : "Thanks. We will look at it.";
          toast.hidden = false;
          toast.className = "gd-flag-toast gd-flag-toast--ok";
          setTimeout(closeModal, 1800);
        } else {
          toast.textContent = "Could not send right now. Try again later.";
          toast.hidden = false;
          toast.className = "gd-flag-toast gd-flag-toast--err";
          send.disabled = false;
          send.textContent = "Send";
        }
      })
      .catch(function () {
        toast.textContent = "Network error. Try again later.";
        toast.hidden = false;
        toast.className = "gd-flag-toast gd-flag-toast--err";
        send.disabled = false;
        send.textContent = "Send";
      });
  }

  // Wire up the trigger(s).
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-gd-flag=\"open\"]");
    if (!t) return;
    e.preventDefault();
    openModal();
  });
})();
