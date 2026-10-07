// Dev-only: fake chrome.storage so the content script can be pasted into a page for testing.
(() => {
  const ids = [...document.querySelectorAll('svg.punch-filmstrip-thumbnails > g.punch-filmstrip-thumbnail')]
    .map(g => [g.dataset.slidePageId, +/translate\(\s*[-\d.]+[ ,]+([-\d.]+)/.exec(g.getAttribute('transform'))[1]])
    .sort((a, b) => a[1] - b[1]).map(a => a[0]);
  const deck = location.pathname.match(/\/d\/([^/]+)/)[1];
  const indent = {}; ids.slice(8, 20).forEach(id => indent[id] = 1); // slides 9–20 under slide 8
  const mem = { ['deck:' + deck]: window.__sgSeed || { indent, collapsed: { [ids[7]]: true }, labels: {} } }; // set window.__sgSeed first to start from another state
  const listeners = [];
  window.__sgMem = mem;
  window.chrome = window.chrome || {};
  chrome.storage = {
    sync: {
      get: async k => ({ [k]: mem[k] }),
      set: async o => { Object.assign(mem, o); },
      remove: async k => { delete mem[k]; },
    },
    onChanged: { addListener: f => listeners.push(f) },
  };
})();
