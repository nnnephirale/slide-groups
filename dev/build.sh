#!/bin/sh
# Dev-only: bundle css + fake storage + extension scripts into one file for pasting into a page.
cd "$(dirname "$0")/.."
{
  printf '(()=>{const s=document.createElement("style");s.textContent=%s;document.head.appendChild(s)})();\n' "$(python3 -c 'import json;print(json.dumps(open("extension/content.css").read()))')"
  cat dev/shim.js extension/store.js
  # expose internals for poking at in the console
  sed 's|^  let press = null;.*|&\n  window.__sg = { get L() { return L; }, get state() { return state; }, rerender: () => { lastOverlaySig = ""; render(); } };|' extension/content.js
} > dev/inject.js
