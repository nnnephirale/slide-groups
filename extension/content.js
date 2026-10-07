// Slide Groups — Keynote-style indented, collapsible slides for Google Slides.
//
// How it works (and why):
// - Google draws the filmstrip as one <svg>, each slide a <g class="punch-filmstrip-thumbnail">
//   placed with transform="translate(0 y)". We never touch Google's attributes; instead we
//   write a <style> sheet that overrides `transform` / `display` per slide id. CSS beats the
//   attribute, and Google re-rendering a thumbnail can't undo it.
// - Google decides which slide you clicked from the mouse Y, not from the element under it.
//   So once slides are hidden and the rest move up, every pointer event over the filmstrip
//   is swallowed and re-dispatched with its Y mapped from our layout back to Google's.

(() => {
  const SLOTS_SEL = "svg.punch-filmstrip-thumbnails";
  // (Google adds ghost copies of the dragged thumbnails while you drag; never count those)
  const THUMB_SEL = "g.punch-filmstrip-thumbnail:not(.punch-filmstrip-dragged-thumbnail)";
  const MAX_LEVEL = 5;
  const INDENT_PX = 14;

  const deckId = (location.pathname.match(/\/d\/([^/]+)/) || [])[1];
  if (!deckId) return;

  let state = { indent: {}, collapsed: {}, labels: {} };
  let L = null; // current layout, see computeLayout()
  let filmstripActive = false; // last mousedown landed in the filmstrip
  let drag = null; // { moved } while a press that began on the filmstrip is held
  let press = null; // { at, scroll } of the last filmstrip press, to undo Google's scroll-to-its-layout

  // ---------- reading Google's filmstrip ----------

  const svgEl = () => document.querySelector(SLOTS_SEL);
  const scroller = () => document.querySelector(".punch-filmstrip-scroll");

  const yOf = (g) => {
    const m = /translate\(\s*[-\d.]+[ ,]+([-\d.]+)/.exec(g.getAttribute("transform") || "");
    return m ? parseFloat(m[1]) : NaN;
  };

  // Google only draws thumbnails once they've been scrolled near, so slides we haven't seen
  // yet are holes (undefined) in `ids`. A thumbnail's position comes from its page number.
  function readSlides() {
    const svg = svgEl();
    if (!svg) return null;
    const thumbs = [...svg.querySelectorAll(`:scope > ${THUMB_SEL}`)]
      .map((g) => ({
        g, id: g.dataset.slidePageId, y: yOf(g),
        idx: parseInt(g.querySelector(":scope > text.punch-filmstrip-thumbnail-pagenumber")?.textContent, 10) - 1,
      }))
      .filter((t) => t.id && !isNaN(t.y) && t.idx >= 0)
      .sort((a, b) => a.idx - b.idx);
    if (!thumbs.length) return null;
    const a = thumbs[0], b = thumbs[thumbs.length - 1];
    const slotH = b.idx > a.idx ? (b.y - a.y) / (b.idx - a.idx) : 102;
    const top0 = a.y - a.idx * slotH;
    const origH = parseFloat(svg.getAttribute("height")) || 0;
    const total = parseInt(document.getElementById("punch-total-slide-count")?.textContent, 10);
    const n = Math.max(b.idx + 1, total || Math.round((origH - top0) / slotH));
    const ids = new Array(n);
    for (const t of thumbs) ids[t.idx] = t.id;
    const inner = a.g.querySelector(":scope > g[transform]");
    const m = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)/.exec(inner?.getAttribute("transform") || "");
    const box = a.g.querySelector(":scope > rect.punch-filmstrip-thumbnail-border-inner");
    return {
      svg,
      ids,
      complete: thumbs.length === n,
      top0,
      slotH,
      origH,
      // the slide image box inside a slot, used to shrink indented thumbnails
      img: m
        ? { x: +m[1], y: +m[2], w: +(box?.getAttribute("width") || 146) - 2, h: +(box?.getAttribute("height") || 82) - 2 }
        : { x: 46, y: 9, w: 146, h: 82 },
    };
  }

  // ---------- layout: order + indent → levels, hidden, visual slots ----------

  function computeLayout(read) {
    const { ids } = read;
    const n = ids.length;
    const level = new Array(n);
    const hidden = new Array(n).fill(false);
    const hasKids = new Array(n).fill(false);
    const lastDesc = new Array(n);
    // Keynote rule: a slide can sit at most one level deeper than the slide above it.
    for (let i = 0; i < n; i++) {
      const want = state.indent[ids[i]] || 0;
      level[i] = i === 0 ? 0 : Math.min(want, level[i - 1] + 1);
    }
    const stack = []; // open ancestors: indices
    for (let i = 0; i < n; i++) {
      while (stack.length && level[stack[stack.length - 1]] >= level[i]) stack.pop();
      if (stack.length) hasKids[stack[stack.length - 1]] = true;
      hidden[i] = stack.some((a) => state.collapsed[ids[a]]);
      stack.push(i);
    }
    for (let i = n - 1; i >= 0; i--) {
      let j = i;
      while (j + 1 < n && level[j + 1] > level[i]) j++;
      lastDesc[i] = j;
    }
    const visible = []; // visual slot → real index
    const vOf = new Array(n).fill(-1); // real index → visual slot
    for (let i = 0; i < n; i++) if (!hidden[i]) vOf[i] = visible.push(i) - 1;
    return { ...read, n, level, hidden, hasKids, lastDesc, visible, vOf, identity: visible.length === n };
  }

  // ---------- rendering ----------

  const styleEl = document.createElement("style");
  styleEl.id = "sg-style";
  let overlay = null;
  let lastCss = "";
  let lastOverlaySig = "";

  const sel = (id) => `${SLOTS_SEL} > ${THUMB_SEL}[data-slide-page-id="${CSS.escape(id)}"]`;

  function render() {
    const read = readSlides();
    if (!read) return;
    L = computeLayout(read);
    const { ids, top0, slotH, img } = L;
    let css = "";

    for (let i = 0; i < L.n; i++) {
      if (!ids[i]) continue; // not drawn by Google yet
      const s = sel(ids[i]);
      if (L.hidden[i]) {
        css += `${s}{display:none!important}`;
        continue;
      }
      if (L.vOf[i] !== i) css += `${s}{transform:translate(0px,${top0 + L.vOf[i] * slotH}px)!important}`;
      const lv = L.level[i];
      if (lv) {
        // Shrink the slide image toward its right edge so it reads as indented.
        const d = lv * INDENT_PX;
        const k = (img.w - d) / img.w;
        const ox = img.x + img.w, oy = img.y + img.h / 2; // scale origin
        const ax = ox * (1 - k), ay = oy * (1 - k);
        const gx = ax + k * img.x, gy = ay + k * img.y; // folds Google's translate(46 9) into ours
        css += `${s}>g[transform]{transform:translate(${gx}px,${gy}px) scale(${k})!important}`;
        css += `${s}>rect:not(.punch-filmstrip-thumbnail-background){transform:translate(${ax}px,${ay}px) scale(${k})!important}`;
      }
    }
    const hiddenCount = L.n - L.visible.length;
    // (not mid-sweep: the sweep needs Google's full scroll range)
    if (hiddenCount && !sweeping) css += `${SLOTS_SEL}{height:${L.origH - hiddenCount * slotH}px!important}`;

    if (css !== lastCss) {
      styleEl.textContent = lastCss = css;
      if (!styleEl.isConnected) document.head.appendChild(styleEl);
    }
    if (sweeping) return;
    watchDeckChanges();
    if (pendingDrop) applyDrop();
    renderOverlay();
    revealSelected();
    // every slide must be drawn to know what's selected, hidden or labelled: once per load,
    // and again whenever the deck has groups
    if (!L.complete && (!primed || Object.keys(state.indent).length)) sweep();
  }

  // Collapsed groups need every thumbnail drawn: hidden ones to know who's hidden, and the
  // ones further down because they move up into view. Google only draws thumbnails near the
  // scroll position, so scroll through the filmstrip once (hidden from view), then put it back.
  let sweeping = false;
  let primed = false;
  let lastSweep = -Infinity;
  async function sweep() {
    const sc = scroller();
    // (a background tab or a filmstrip that isn't laid out yet has no size to scroll through)
    if (!sc || !sc.clientHeight || document.hidden || sweeping || performance.now() - lastSweep < 5000) return;
    if (drag || recentPress()) return void setTimeout(schedule, 700); // not under your hands
    sweeping = true;
    primed = true;
    lastSweep = performance.now();
    const keep = sc.scrollTop;
    document.documentElement.classList.add("sg-sweeping");
    render(); // drops our height override so the whole range is reachable
    try {
      for (let y = 0; y < sc.scrollHeight; y += sc.clientHeight) {
        const from = Math.floor((y - L.top0) / L.slotH), to = Math.ceil((y + sc.clientHeight - L.top0) / L.slotH);
        const missing = () => {
          const r = readSlides();
          if (!r) return false;
          for (let i = Math.max(0, from); i <= Math.min(r.n - 1, to); i++) if (!r.ids[i]) return true;
          return false;
        };
        if (!missing()) continue;
        sc.scrollTop = y;
        for (let t = performance.now(); missing() && performance.now() - t < 500; ) {
          await new Promise((r) => setTimeout(r, 30));
        }
        if (readSlides()?.complete) break;
      }
    } finally {
      sweeping = false;
      lastCss = "";
      render();
      sc.scrollTop = keep;
      document.documentElement.classList.remove("sg-sweeping");
    }
  }

  // Google Docs enforces Trusted Types, so no innerHTML: build nodes by hand.
  const NS = "http://www.w3.org/2000/svg";
  function chevron() {
    const s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 16 16");
    s.setAttribute("width", "16");
    s.setAttribute("height", "16");
    s.setAttribute("aria-hidden", "true");
    const p = document.createElementNS(NS, "path");
    for (const [k, v] of Object.entries({
      d: "M6 4l4 4-4 4", fill: "none", stroke: "currentColor",
      "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round",
    })) p.setAttribute(k, v);
    s.appendChild(p);
    return s;
  }

  // Reuses the existing button for a slide when there is one, so the chevron can animate.
  // x (svg-local) of the middle of a slide's number, so the chevron sits right under it
  function numberCenter(id) {
    try {
      const bb = L.svg.querySelector(`${sel(id)} > text.punch-filmstrip-thumbnail-pagenumber`).getBBox();
      if (bb.width) return bb.x + bb.width / 2;
    } catch {}
    return 23;
  }

  function toggleButton([id, v, open, count]) {
    let b = overlay.querySelector(`.sg-toggle[data-id="${CSS.escape(id)}"]`);
    if (!b) {
      b = document.createElement("button");
      b.dataset.id = id;
      b.appendChild(chevron());
      const c = document.createElement("span");
      c.className = "sg-count";
      b.appendChild(c);
    }
    b.className = "sg-toggle" + (open ? " sg-open" : "");
    // bottom of the row: Google stacks its own indicator icons under the slide number
    b.style.top = `${L.top0 + v * L.slotH + L.slotH - 38}px`;
    b.style.left = `${Math.max(2, numberCenter(id) - 11)}px`;
    b.title = `${open ? "Collapse" : "Expand"} ${count} slide${count > 1 ? "s" : ""} (⌥-click: all groups)`;
    b.lastChild.textContent = open ? "" : count;
    return b;
  }

  function renderOverlay() {
    const sc = scroller();
    if (!sc || !L) return;
    if (!overlay || !overlay.isConnected) {
      overlay = document.createElement("div");
      overlay.className = "sg-overlay sg-ui";
      overlay.addEventListener("click", onToggleClick);
      sc.appendChild(overlay);
      pinScroll(sc);
      lastOverlaySig = "";
    }
    const rows = [];
    for (let i = 0; i < L.n; i++) {
      if (!L.ids[i] || L.hidden[i] || !L.hasKids[i]) continue;
      const open = !state.collapsed[L.ids[i]];
      rows.push([L.ids[i], L.vOf[i], open, L.lastDesc[i] - i, i, L.level[i], state.labels[L.ids[i]] || ""]);
    }
    const sig = JSON.stringify([rows, L.top0, L.slotH]);
    if (sig === lastOverlaySig) return;
    lastOverlaySig = sig;
    // update in place (never re-insert): a label being typed in must keep focus
    const keep = new Set();
    for (const row of rows) {
      for (const el of [toggleButton(row), labelField(row)]) {
        keep.add(el);
        if (!el.isConnected) overlay.appendChild(el);
      }
    }
    for (const el of [...overlay.children]) if (!keep.has(el)) el.remove();
  }

  // ---------- group labels ----------
  //
  // A small field on each group's first slide. It sits on the thumbnail, so it's frosted
  // glass in whichever tone stands out from that slide's background.

  function labelField([id, , , , i]) {
    let f = overlay.querySelector(`.sg-label[data-id="${CSS.escape(id)}"]`);
    if (!f) {
      f = document.createElement("input");
      Object.assign(f, { type: "text", className: "sg-label", placeholder: "Label", maxLength: 60, spellcheck: false, autocomplete: "off" });
      f.dataset.id = id;
      f.addEventListener("blur", saveLabel);
    }
    const text = state.labels[id] || "";
    if (document.activeElement !== f) f.value = text;
    f.title = text;
    f.classList.toggle("sg-empty", !text);
    f.classList.toggle("sg-on-dark", slideTone(id) === "dark");
    const b = thumbBox(i);
    Object.assign(f.style, { left: `${b.x + 5}px`, top: `${b.y + b.h - 25}px`, maxWidth: `${b.w - 10}px` });
    return f;
  }

  // "light" / "dark" from the slide's background fill; "unknown" for images.
  function slideTone(id) {
    const bg = L.svg.querySelector(`${sel(id)} [id$="-bg"]`);
    if (!bg || bg.querySelector("image")) return "unknown";
    const fills = [...bg.querySelectorAll("[fill]")].map((n) => n.getAttribute("fill")).filter((f) => f && f !== "none");
    const m = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(fills[fills.length - 1] || "");
    if (!m) return "unknown";
    const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    const [r, g, b] = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16));
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "light" : "dark";
  }

  function saveLabel(e) {
    const f = e.target, id = f.dataset.id, text = f.value.trim();
    if (text === (state.labels[id] || "")) return;
    record();
    if (text) state.labels[id] = text;
    else delete state.labels[id];
    commit();
  }

  // Keys typed into a label belong to the label, not to Slides' shortcuts.
  function labelKey(e) {
    if (e.type === "keydown" && e.key === "Enter") e.target.blur();
    if (e.type === "keydown" && e.key === "Escape") {
      e.target.value = state.labels[e.target.dataset.id] || "";
      e.target.blur();
    }
    e.stopImmediatePropagation();
  }
  for (const t of ["keydown", "keypress", "keyup", "beforeinput", "input", "paste", "cut", "copy"]) {
    window.addEventListener(t, (e) => e.target?.closest?.(".sg-label") && labelKey(e), true);
  }

  // Empty labels only show on the row you're pointing at.
  let hoverId = null;
  function setHover(id) {
    if (id === hoverId || !overlay) return;
    overlay.querySelector(`.sg-label[data-id="${CSS.escape(hoverId || "")}"]`)?.classList.remove("sg-hover");
    hoverId = id;
    if (id) overlay.querySelector(`.sg-label[data-id="${CSS.escape(id)}"]`)?.classList.add("sg-hover");
  }

  // ---------- state changes ----------

  let saveTimer = 0;
  let lastSaved = "";
  const asJson = (s) => JSON.stringify([s.indent, s.collapsed, s.labels]);
  function commit() {
    // only forget deleted slides once we've seen every slide, or we'd drop undrawn ones
    if (L?.complete) SlideGroupStore.prune(state, L.ids);
    lastOverlaySig = "";
    render();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      lastSaved = asJson(state);
      SlideGroupStore.save(deckId, state);
    }, 300);
  }

  // ---------- undo / redo ----------
  //
  // One timeline shared with Slides' own undo. Grouping changes are entries here; edits we
  // see you make to the deck are "google" markers. ⌘Z undoes whichever came last, and a
  // marker means "let Slides undo this one". A drop that moved slides is both: we restore
  // the grouping and let Slides undo the move.

  const undoStack = [];
  const redoStack = [];
  let expectDeckChangeUntil = 0; // Slides is applying a move/undo we caused; not a new edit
  const snap = () => JSON.stringify({ indent: state.indent, labels: state.labels });

  function record(movesSlides = false, before = snap()) {
    undoStack.push({ kind: "ours", snap: before, movesSlides });
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }

  function googleEdited() {
    const now = performance.now();
    if (now < expectDeckChangeUntil) return;
    const top = undoStack[undoStack.length - 1];
    // a burst of edits (typing a word, nudging a shape) ≈ one Slides undo step
    if (top?.kind === "google" && now - top.at < 1500) top.at = now;
    else undoStack.push({ kind: "google", at: now });
    redoStack.length = 0;
  }

  // Returns true when we handled it all and Slides must not see the key.
  function undoRedo(redo) {
    const from = redo ? redoStack : undoStack, to = redo ? undoStack : redoStack;
    const top = from.pop();
    expectDeckChangeUntil = performance.now() + 1500;
    if (!top) return false;
    if (top.kind === "google") {
      to.push(top);
      return false;
    }
    to.push({ kind: "ours", snap: snap(), movesSlides: top.movesSlides });
    const s = JSON.parse(top.snap);
    state.indent = s.indent;
    state.labels = s.labels;
    commit();
    return !top.movesSlides;
  }

  // Slides' own Undo/Redo buttons only touch Slides' steps.
  function googleUndoButton(redo) {
    const from = redo ? redoStack : undoStack, to = redo ? undoStack : redoStack;
    for (let i = from.length - 1; i >= 0; i--) {
      if (from[i].kind === "google") {
        to.push(...from.splice(i, 1));
        break;
      }
    }
    expectDeckChangeUntil = performance.now() + 1500;
  }

  // Slides added, deleted or reordered by something other than our own drops.
  let lastPos = null;
  let lastN = 0;
  function watchDeckChanges() {
    const now = positions();
    if (lastPos && !pendingDrop && performance.now() > expectDeckChangeUntil) {
      if (L.n !== lastN || [...lastPos].some(([id, i]) => now.has(id) && now.get(id) !== i)) googleEdited();
    }
    lastPos = now;
    lastN = L.n;
  }

  const NOT_EDITS = new Set(["Shift", "Meta", "Control", "Alt", "CapsLock", "Escape", "ArrowUp", "ArrowDown",
    "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "F1", "F5", "F11", "F12"]);
  function isEditKey(e) {
    if (NOT_EDITS.has(e.key)) return false;
    if (e.metaKey || e.ctrlKey) return !"zycafgpshotwnq".includes(e.key.toLowerCase());
    return e.key.length === 1 || ["Backspace", "Delete", "Enter", "Tab"].includes(e.key);
  }

  // Shapes dragged on the canvas, menu commands and toolbar buttons are edits too.
  let canvasPress = null;
  window.addEventListener("mousedown", (e) => {
    canvasPress = e.isTrusted && e.button === 0 && e.target.closest?.(".workspace-container") ? { x: e.clientX, y: e.clientY } : null;
  }, true);
  window.addEventListener("mouseup", (e) => {
    if (canvasPress && Math.hypot(e.clientX - canvasPress.x, e.clientY - canvasPress.y) > 3) googleEdited();
    canvasPress = null;
  }, true);
  window.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    const t = e.target.closest?.('#undoButton, #redoButton, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], .goog-toolbar-button');
    if (!t) return;
    const text = t.textContent.trim();
    if (t.id === "undoButton" || /^Undo\b/.test(text)) return googleUndoButton(false);
    if (t.id === "redoButton" || /^Redo\b/.test(text)) return googleUndoButton(true);
    googleEdited();
  }, true);

  function onToggleClick(e) {
    const btn = e.target.closest(".sg-toggle");
    if (!btn || !L) return;
    const id = btn.dataset.id;
    const collapse = !state.collapsed[id];
    if (e.altKey) {
      // ⌥-click: same action for every group in the deck
      for (let i = 0; i < L.n; i++) if (L.ids[i] && L.hasKids[i]) state.collapsed[L.ids[i]] = collapse;
    } else {
      state.collapsed[id] = collapse;
    }
    commit();
  }

  function selectedIndices() {
    if (!L) return [];
    const out = new Set();
    L.ids.forEach((id, i) => {
      if (!id) return;
      const style = L.svg.querySelector(`${sel(id)} > rect.punch-filmstrip-thumbnail-border`)?.getAttribute("style") || "";
      // Selected slides get a coloured border; the slide under the pointer gets a grey one.
      const rgb = (/stroke:\s*rgb\((\d+),\s*(\d+),\s*(\d+)/.exec(style) || []).slice(1).map(Number);
      if (/stroke-width:\s*[1-9]/.test(style) && rgb.length && Math.max(...rgb) - Math.min(...rgb) > 24) out.add(i);
    });
    const cur = currentIndex();
    if (cur >= 0) out.add(cur);
    return [...out].sort((a, b) => a - b);
  }

  function currentIndex() {
    const id = (location.hash.match(/slide=id\.([^&]+)/) || [])[1];
    return L && id ? L.ids.indexOf(decodeURIComponent(id)) : -1;
  }

  // Tab / Shift-Tab: indent or outdent the selected slides, taking their sub-slides along.
  function shiftLevel(delta) {
    const idx = selectedIndices();
    if (!idx.length || !L) return false;
    const before = snap();
    const moved = new Set();
    for (const i of idx) {
      if (moved.has(i)) continue;
      const lv = L.level[i];
      const next = lv + delta;
      if (next < 0 || next > MAX_LEVEL) continue;
      if (delta > 0 && (i === 0 || next > L.level[i - 1] + 1)) continue;
      if (delta > 0) {
        // tucking a slide into a collapsed group opens that group, so it doesn't vanish
        let p = i - 1;
        while (p > 0 && L.level[p] > lv) p--;
        delete state.collapsed[L.ids[p]];
      }
      for (let j = i; j <= L.lastDesc[i]; j++) {
        if (moved.has(j)) continue;
        moved.add(j);
        state.indent[L.ids[j]] = Math.max(0, Math.min(MAX_LEVEL, L.level[j] + delta));
      }
    }
    if (moved.size) {
      record(false, before);
      commit();
    }
    return true;
  }

  let lastSelected = "";
  let groupPickUntil = 0; // we're selecting a collapsed group's hidden slides for a press/drag
  function revealSelected() {
    const i = currentIndex();
    if (i < 0) return;
    const isNew = L.ids[i] !== lastSelected;
    lastSelected = L.ids[i];
    if (L.hidden[i] && (drag?.groupPick || performance.now() < groupPickUntil)) {
      setTimeout(schedule, 700); // look again once the press is over
      return;
    }
    if (L.hidden[i]) {
      if (isNew) {
        // Google jumped to a slide we're hiding (find, "go to slide"...): open its group.
        for (let a = i - 1; a >= 0; a--) if (L.lastDesc[a] >= i) delete state.collapsed[L.ids[a]];
        return commit();
      }
      // You collapsed the group around the selected slide: select the group's slide, like Keynote.
      let a = i;
      while (L.hidden[a]) a--;
      return selectReal(a);
    }
    if (isNew) {
      keepInView(i);
      requestAnimationFrame(() => keepInView(i));
      setTimeout(() => keepInView(i), 80);
    }
  }

  function selectReal(i, mods) {
    const r = L.svg.getBoundingClientRect();
    synthClick(L.svg, r.left + r.width / 2, realClientY(i, r), mods);
  }

  // Selecting a slide makes Google scroll the filmstrip to where *it* thinks that slide is.
  // We answer every such scroll with the smallest scroll, from where you were just before
  // the click or key press, that shows the slide in *our* layout.
  const recentPress = () => press && performance.now() - press.at < 600;
  const markPress = () => (press = { at: performance.now(), scroll: scroller()?.scrollTop ?? 0 });

  function scrollFor(i, base, sc) {
    const top = L.top0 + L.vOf[i] * L.slotH;
    if (top < base) return top - 8;
    if (top + L.slotH > base + sc.clientHeight) return top + L.slotH - sc.clientHeight + 8;
    return base;
  }

  function keepInView(i = currentIndex()) {
    const sc = scroller();
    if (!sc || !L || L.identity || i < 0 || L.hidden[i] || drag?.moved) return;
    const want = scrollFor(i, recentPress() ? press.scroll : sc.scrollTop, sc);
    if (Math.abs(sc.scrollTop - want) > 1) sc.scrollTop = want;
  }

  const pinned = new WeakSet();
  function pinScroll(sc) {
    if (pinned.has(sc)) return;
    pinned.add(sc);
    sc.addEventListener("scroll", () => {
      if (drag?.moved) {
        // Google auto-scrolls when *its* idea of the pointer nears an edge; only allow
        // that when the real pointer is near one.
        const r = sc.getBoundingClientRect();
        if (drag.cy > r.top + 48 && drag.cy < r.bottom - 48) sc.scrollTop = drag.scroll;
        else drag.scroll = sc.scrollTop;
        return;
      }
      if (recentPress()) keepInView();
    });
    sc.addEventListener("wheel", () => (press = null), { passive: true });
  }

  // ---------- pointer remapping ----------

  // Visual Y (svg-local) → the Y Google expects for the same spot in its own layout.
  function toRealY(ly) {
    const v = Math.floor((ly - L.top0) / L.slotH);
    if (v < 0) return ly;
    if (v >= L.visible.length) return ly + (L.n - L.visible.length) * L.slotH;
    let off = ly - (L.top0 + v * L.slotH);
    let real = L.visible[v];
    // While dragging, the lower half of a collapsed group means "drop after the whole group".
    if (drag?.moved && off > L.slotH / 2 && L.lastDesc[real] > real && state.collapsed[L.ids[real]]) {
      real = L.lastDesc[real];
    }
    return L.top0 + real * L.slotH + off;
  }

  function realClientY(i, svgRect) {
    return svgRect.top + L.top0 + i * L.slotH + L.slotH / 2;
  }

  function cloneEvent(e, dy) {
    const init = {
      bubbles: e.bubbles, cancelable: e.cancelable, composed: e.composed, view: window,
      detail: e.detail, screenX: e.screenX, screenY: e.screenY + dy, clientX: e.clientX, clientY: e.clientY + dy,
      ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
      button: e.button, buttons: e.buttons, relatedTarget: e.relatedTarget,
    };
    if (e instanceof PointerEvent) {
      Object.assign(init, {
        pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary,
        width: e.width, height: e.height, pressure: e.pressure,
      });
      return new PointerEvent(e.type, init);
    }
    return new MouseEvent(e.type, init);
  }

  function synthClick(target, x, y, mods = {}) {
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, ...mods };
    target.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
    target.dispatchEvent(new MouseEvent("mouseup", base));
    target.dispatchEvent(new MouseEvent("click", base));
  }

  const POINTER_EVENTS = [
    "pointerdown", "pointermove", "pointerup", "mousedown", "mousemove", "mouseup",
    "click", "dblclick", "contextmenu", "mouseover", "mouseout",
  ];

  function onPointer(e) {
    if (!e.isTrusted) return; // our own re-dispatched copies
    const svg = svgEl();
    const inFilm = !!e.target.closest?.("#filmstrip");
    const onToggle = !!e.target.closest?.(".sg-toggle, .sg-label");
    const isMove = e.type.endsWith("move"), isUp = e.type.endsWith("up");
    if (svg && L && (isMove || e.type === "mouseover")) {
      const r = svg.getBoundingClientRect();
      const v = Math.floor((e.clientY - r.top - L.top0) / L.slotH);
      setHover(inFilm && !drag?.moved ? L.ids[L.visible[v]] ?? null : null);
    }

    if (e.type === "mousedown" || e.type === "pointerdown") {
      filmstripActive = inFilm;
      if (inFilm && !onToggle && e.button === 0) {
        drag = drag || { moved: false, y: e.clientY, ids: [], scroll: scroller()?.scrollTop ?? 0 };
        nestTarget = -1;
      }
      if (inFilm && !onToggle) markPress();
    }
    if (onToggle) {
      // keep Google from seeing presses on our buttons and labels; our own handlers still run
      if (e.type !== "click") e.stopPropagation();
      return;
    }
    if (!svg || !L || !(svg.contains(e.target) || (drag && (isMove || isUp)))) return endPress(e);

    const r = svg.getBoundingClientRect();
    const lx = e.clientX - r.left, ly = e.clientY - r.top;

    // What a drag will carry, read on press: once a drag starts Google stops marking the
    // lifted slides as selected. Pressing a selected slide drags the whole selection;
    // pressing any other slide drags just that one (or its whole group, if collapsed).
    if (e.type === "pointerdown" && drag && !drag.pressIds && e.button === 0) {
      const p = L.visible[Math.floor((ly - L.top0) / L.slotH)];
      if (p !== undefined && L.ids[p] && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        const picked = selectedIndices();
        if (picked.includes(p)) drag.pressIds = picked.map((i) => L.ids[i]);
        else if (state.collapsed[L.ids[p]]) drag.pressIds = L.ids.slice(p, L.lastDesc[p] + 1);
        else drag.pressIds = [L.ids[p]];
      }
    }
    if (drag && isMove) {
      drag.cy = e.clientY;
      if (!drag.moved && Math.abs(e.clientY - drag.y) > 4) {
        drag.moved = true;
        drag.ids = (drag.pressIds || selectedIndices().map((i) => L.ids[i])).filter(Boolean);
      }
    }
    if (drag?.moved && (isMove || isUp)) {
      const inside = lx >= 0 && lx <= r.width;
      const t = inside ? nestTargetAt(lx, ly) : -1;
      nestTarget = t >= 0 && !drag.ids.includes(L.ids[t]) ? t : -1;
      const o = inside && nestTarget < 0 ? outTargetAt(lx, ly) : -1;
      outTarget = o >= 0 && !drag.ids.includes(L.ids[o]) ? o : -1;
    }

    // Dropping into a slide, or out of a group, = dropping right after the end of that group.
    const group = nestTarget >= 0 ? nestTarget : outTarget;
    const realY = group >= 0 ? L.top0 + L.lastDesc[group] * L.slotH + L.slotH * 0.75 : toRealY(ly);
    const dy = realY - ly;

    // Pressing a collapsed group selects the whole group first, so a drag moves it all.
    if (e.type === "mousedown" && e.button === 0 && !e.shiftKey && !e.metaKey && !e.ctrlKey && !L.identity) {
      const v = Math.floor((ly - L.top0) / L.slotH);
      const i = L.visible[v];
      if (i !== undefined && state.collapsed[L.ids[i]] && L.lastDesc[i] > i) {
        groupPickUntil = performance.now() + 1000;
        if (drag) drag.groupPick = true;
        synthClick(e.target, e.clientX, realClientY(i, r));
        synthClick(e.target, e.clientX, realClientY(L.lastDesc[i], r), { shiftKey: true });
      }
    }

    // Remember what was dropped where; levels are fixed up once Google has moved the slides.
    if (e.type === "mouseup" && drag?.moved && drag.ids.length && lx >= 0 && lx <= r.width) {
      pendingDrop = {
        ids: drag.ids, before: positions(), at: performance.now(),
        target: nestTarget >= 0 ? L.ids[nestTarget] : null,
        out: outTarget >= 0,
      };
      expectDeckChangeUntil = performance.now() + 2000; // the move is part of this drop
    }

    if (dy !== 0) {
      e.stopImmediatePropagation();
      const copy = cloneEvent(e, dy);
      e.target.dispatchEvent(copy);
      if (copy.defaultPrevented) e.preventDefault();
    }
    if (drag?.moved && isMove) requestAnimationFrame(() => paintDrag(dy));
    endPress(e);
  }
  for (const t of POINTER_EVENTS) window.addEventListener(t, onPointer, true);

  function endPress(e) {
    if (e.type === "mouseup" || (e.type === "pointerup" && e.pointerType !== "mouse")) {
      if (drag?.groupPick) groupPickUntil = performance.now() + 600;
      if (drag?.moved) clearDrag();
      drag = null;
    }
  }

  // ---------- drag onto a slide = make sub-slides ----------
  //
  // While dragging, the lower-right of a thumbnail is a "drop into" zone: the dragged slides
  // land at the end of that slide's group as its sub-slides. Anywhere else is Google's normal
  // reorder, and dropped slides take the level of the slide they land above (so dragging a
  // sub-slide out between top-level slides makes it top-level again).

  let nestTarget = -1; // real index of the slide being dropped into
  let outTarget = -1; // real index of the group being dragged out of (its top slide)
  let outLine = null;
  let pendingDrop = null; // { ids, before, target, at } until Google has moved the slides
  const dragStyle = document.createElement("style");
  dragStyle.id = "sg-drag-style";
  let nestBox = null;

  function nestTargetAt(lx, ly) {
    const v = Math.floor((ly - L.top0) / L.slotH);
    const i = L.visible[v];
    if (i === undefined || !L.ids[i] || L.level[i] >= MAX_LEVEL) return -1;
    const offY = ly - (L.top0 + v * L.slotH);
    // right ~65% of the thumbnail, lower ~60% of its row (gap below included)
    return lx >= L.img.x + L.img.w * 0.35 && offY >= L.slotH * 0.4 ? i : -1;
  }

  // The left part of a sub-slide's row (thumbnail edge + number gutter) is "out of the group":
  // the dropped slides land right after the whole group, at the top level.
  function outTargetAt(lx, ly) {
    let i = L.visible[Math.floor((ly - L.top0) / L.slotH)];
    if (i === undefined || !L.ids[i] || !L.level[i] || lx >= L.img.x + L.img.w * 0.35) return -1;
    while (i > 0 && L.level[i] > 0) i--;
    return i;
  }

  function thumbBox(i) {
    const { img } = L;
    const d = L.level[i] * INDENT_PX, k = (img.w - d) / img.w, h = img.h * k;
    return { x: img.x + d, y: L.top0 + L.vOf[i] * L.slotH + img.y + (img.h - h) / 2, w: img.w - d, h };
  }

  // Google draws the drag ghost and its drop line in its own layout; shift them into ours.
  function paintDrag(dy) {
    if (!drag?.moved || !L) return;
    document.documentElement.classList.toggle("sg-nesting", nestTarget >= 0 || outTarget >= 0);
    let css = `${SLOTS_SEL} > g.punch-filmstrip-dragged-thumbnail{translate:0 ${-dy}px}`;
    const line = L.svg.querySelector(":scope > rect.punch-filmstrip-cursor");
    const y = parseFloat(line?.getAttribute("y"));
    if (!L.identity && nestTarget < 0 && outTarget < 0 && !isNaN(y)) {
      let j = Math.round((y + 1 - L.top0) / L.slotH); // the slide just below the line
      while (j < L.n && L.hidden[j]) j++;
      const vy = L.top0 + (j < L.n ? L.vOf[j] : L.visible.length) * L.slotH - 1;
      css += `${SLOTS_SEL} > rect.punch-filmstrip-cursor{translate:0 ${vy - (y + 1)}px}`;
    }
    dragStyle.textContent = css;
    if (!dragStyle.isConnected) document.head.appendChild(dragStyle);

    const sc = scroller();
    if (!sc) return;
    if (!nestBox || !nestBox.isConnected) {
      nestBox = document.createElement("div");
      nestBox.className = "sg-nest sg-ui";
      const label = document.createElement("span");
      label.className = "sg-nest-label";
      label.textContent = "↳ Add as sub-slides";
      nestBox.appendChild(label);
      sc.appendChild(nestBox);
    }
    if (nestTarget >= 0) {
      const b = thumbBox(nestTarget);
      Object.assign(nestBox.style, { left: `${b.x - 4}px`, top: `${b.y - 4}px`, width: `${b.w + 8}px`, height: `${b.h + 8}px` });
    }
    nestBox.classList.toggle("sg-on", nestTarget >= 0);

    if (!outLine || !outLine.isConnected) {
      outLine = document.createElement("div");
      outLine.className = "sg-out sg-ui";
      const label = document.createElement("span");
      label.className = "sg-nest-label";
      label.textContent = "↰ Out of group";
      outLine.appendChild(label);
      sc.appendChild(outLine);
    }
    if (outTarget >= 0) {
      let j = L.lastDesc[outTarget];
      while (j > outTarget && L.hidden[j]) j--;
      const top = L.top0 + L.vOf[j] * L.slotH + (L.img.y + L.img.h + L.slotH + L.img.y) / 2; // middle of the gap below
      Object.assign(outLine.style, { left: `${L.img.x - 4}px`, top: `${top - 1.5}px`, width: `${L.img.w + 8}px` });
    }
    outLine.classList.toggle("sg-on", outTarget >= 0);
  }

  function clearDrag() {
    nestTarget = -1;
    outTarget = -1;
    outLine?.classList.remove("sg-on");
    dragStyle.textContent = "";
    document.documentElement.classList.remove("sg-nesting");
    nestBox?.classList.remove("sg-on");
  }

  // id → index for the slides Google has drawn so far
  const positions = () => new Map(L.ids.flatMap((id, i) => (id ? [[id, i]] : [])));

  function applyDrop() {
    const p = pendingDrop;
    // compare only slides seen both times: Google keeps drawing new thumbnails during a drag
    const now = positions();
    const moved = [...p.before].some(([id, i]) => now.has(id) && now.get(id) !== i);
    if (!moved && performance.now() - p.at < 250) {
      setTimeout(schedule, 300); // Google may still be applying the move
      return;
    }
    pendingDrop = null;
    if (!moved && !p.target && !p.out) return; // dropped back where it was
    const before = snap();
    const idx = p.ids.map((id) => L.ids.indexOf(id)).filter((i) => i >= 0).sort((a, b) => a - b);
    if (!idx.length) return;
    let base;
    if (p.out) {
      base = 0;
    } else if (p.target) {
      const t = L.ids.indexOf(p.target);
      if (t < 0) return;
      base = L.level[t] + 1;
    } else {
      const below = L.ids[idx[idx.length - 1] + 1];
      base = below ? state.indent[below] || 0 : 0;
    }
    // keep the dragged slides' own nesting relative to each other
    const rel = idx.map((i) => state.indent[L.ids[i]] || 0);
    const min = Math.min(...rel);
    idx.forEach((i, k) => {
      const lv = Math.min(MAX_LEVEL, base + rel[k] - min);
      if (lv) state.indent[L.ids[i]] = lv;
      else delete state.indent[L.ids[i]];
    });
    record(moved, before);
    commit();
  }

  // ---------- keyboard ----------
  // Slides keeps keyboard focus in an offscreen iframe, so we listen there too.

  function onKey(e) {
    if (e.isComposing || e.target?.closest?.(".sg-label")) return;
    const k = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (k === "z" || (k === "y" && !e.shiftKey))) {
      // other text boxes (font size, search…) keep their own undo
      if (e.target?.ownerDocument === document && (/^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable)) return;
      if (undoRedo(k === "y" || e.shiftKey)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (filmstripActive && L && filmstripKey(e)) return;
    if (isEditKey(e)) googleEdited();
  }

  // Returns true when the key was ours.
  function filmstripKey(e) {
    markPress();
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (shiftLevel(e.shiftKey ? -1 : 1)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return true;
      }
      return false;
    }
    // Arrow keys step over collapsed slides, like Keynote.
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.metaKey && !e.ctrlKey && !e.altKey && !L.identity) {
      const i = currentIndex();
      if (i < 0) return false;
      const step = e.key === "ArrowDown" ? 1 : -1;
      let j = i + step;
      while (j >= 0 && j < L.n && L.hidden[j]) j += step;
      if (j === i + step || j < 0 || j >= L.n) return false; // nothing hidden in the way: let Google do it
      e.preventDefault();
      e.stopImmediatePropagation();
      selectReal(j, { shiftKey: e.shiftKey });
      return true;
    }
    return false;
  }
  window.addEventListener("keydown", onKey, true);

  const hooked = new WeakSet();
  function hookIframes() {
    for (const f of document.querySelectorAll("iframe.docs-texteventtarget-iframe")) {
      try {
        const w = f.contentWindow;
        if (w && !hooked.has(w)) {
          w.addEventListener("keydown", onKey, true);
          hooked.add(w);
        }
      } catch {}
    }
  }

  // ---------- boot ----------

  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      hookIframes();
      render();
    });
  }

  // (ignore our own UI changing, or every redraw would trigger another)
  const ours = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest(".sg-ui");
  const mo = new MutationObserver((muts) => {
    for (const m of muts) if (!ours(m.target)) return schedule();
  });

  document.addEventListener("visibilitychange", schedule);

  SlideGroupStore.onChange(deckId, (s) => {
    // our own save echoing back, or one still on its way out
    if (saveTimer || asJson(s) === lastSaved) return;
    lastSaved = asJson(s);
    state = s;
    lastOverlaySig = "";
    schedule();
  });

  (async function boot() {
    state = await SlideGroupStore.load(deckId);
    lastSaved = asJson(state);
    const wait = () => {
      const fs = document.getElementById("filmstrip");
      if (!fs) return setTimeout(wait, 500);
      mo.observe(fs, { subtree: true, childList: true, attributes: true, attributeFilter: ["transform", "height", "style"] });
      schedule();
    };
    wait();
    // Selection changes don't always mutate the filmstrip; watch the URL too.
    let lastHash = location.hash;
    setInterval(() => {
      if (location.hash !== lastHash) {
        lastHash = location.hash;
        schedule();
      }
    }, 150);
  })();
})();
