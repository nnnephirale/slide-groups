// Group data lives in chrome.storage.sync, so it follows your Chrome profile
// to every desktop signed into the same Google account with sync on.
//
// Shape, per presentation:
//   "deck:<presentationId>" -> {
//     indent:    { [slideId]: 1..5 },
//     collapsed: { [slideId]: true },
//     labels:    { [slideId]: "Group name" },
//   }
//
// Structure is derived from slide ORDER + indent, exactly like Keynote:
// a slide's children are the slides right after it with a deeper indent.
// Moving slides around in Slides therefore re-parents them naturally.
//
// chrome.storage.sync allows 8 KB per item, so a big deck's state is split into
// "deck:<id>#0", "deck:<id>#1"… with "deck:<id>" holding { chunks: n }.

const SlideGroupStore = (() => {
  const key = (deckId) => `deck:${deckId}`;
  const empty = () => ({ indent: {}, collapsed: {}, labels: {} });
  const CHUNK = 7000;

  async function load(deckId) {
    try {
      const k = key(deckId);
      const head = (await chrome.storage.sync.get(k))[k];
      if (!head) return empty();
      if (!head.chunks) return { ...empty(), ...head };
      const keys = Array.from({ length: head.chunks }, (_, i) => `${k}#${i}`);
      const parts = await chrome.storage.sync.get(keys);
      return { ...empty(), ...JSON.parse(keys.map((c) => parts[c] || "").join("")) };
    } catch {
      return empty();
    }
  }

  // Drop entries for slides that no longer exist.
  function prune(state, liveIds) {
    const live = new Set(liveIds);
    for (const part of ["indent", "collapsed", "labels"]) {
      for (const id of Object.keys(state[part])) if (!live.has(id) || !state[part][id]) delete state[part][id];
    }
    return state;
  }

  let lastChunks = 0;
  async function save(deckId, state) {
    const k = key(deckId);
    const isEmpty = ["indent", "collapsed", "labels"].every((p) => !Object.keys(state[p]).length);
    const json = JSON.stringify({ indent: state.indent, collapsed: state.collapsed, labels: state.labels });
    const stale = Array.from({ length: lastChunks }, (_, i) => `${k}#${i}`);
    if (isEmpty) {
      await chrome.storage.sync.remove([k, ...stale]);
      lastChunks = 0;
    } else if (json.length <= CHUNK) {
      await chrome.storage.sync.set({ [k]: JSON.parse(json) });
      if (stale.length) await chrome.storage.sync.remove(stale);
      lastChunks = 0;
    } else {
      const n = Math.ceil(json.length / CHUNK);
      const items = { [k]: { chunks: n } };
      for (let i = 0; i < n; i++) items[`${k}#${i}`] = json.slice(i * CHUNK, (i + 1) * CHUNK);
      await chrome.storage.sync.set(items);
      const extra = stale.slice(n);
      if (extra.length) await chrome.storage.sync.remove(extra);
      lastChunks = n;
    }
  }

  // Fires when another device (or tab) changes this deck's groups.
  function onChange(deckId, cb) {
    const k = key(deckId);
    let timer = 0;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || !Object.keys(changes).some((c) => c === k || c.startsWith(`${k}#`))) return;
      clearTimeout(timer);
      timer = setTimeout(async () => cb(await load(deckId)), 50); // let every chunk land
    });
  }

  return { load, save, prune, onChange };
})();
