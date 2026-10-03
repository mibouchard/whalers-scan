// Browser-like globals so the shared engine (engine/engine.js, the same code the in-browser scan uses) runs in Node.
// localStorage is file-backed under state/ so caches and the 75-day trend history survive between runs (the workflow commits state/).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { DOMParser } from 'linkedom';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const STATE = path.join(ROOT, 'state');
// keys that are only same-day caches: kept in memory, never written to the repo
const VOLATILE = [/^ws\.pool3$/, /^ws\.xfer\./, /^ws\.last$/];
const file = k => path.join(STATE, k.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json');
const mem = new Map();

export const localStorage = {
  getItem(k) {
    if (mem.has(k)) return mem.get(k);
    try { const v = fs.readFileSync(file(k), 'utf8'); mem.set(k, v); return v; } catch { return null; }
  },
  setItem(k, v) { mem.set(k, String(v)); if (!VOLATILE.some(r => r.test(k))) { fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(file(k), String(v)); } },
  removeItem(k) { mem.delete(k); try { fs.unlinkSync(file(k)); } catch { } },
};

globalThis.window = globalThis;
globalThis.localStorage = localStorage;
globalThis.DOMParser = DOMParser;
window.name = '';

export const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' };
const realFetch = globalThis.fetch;
// every request gets a browser user agent and a timeout; KHL /rest/ calls are routed by khl.js
globalThis.fetch = (u, o = {}) => realFetch(u, { ...o, headers: { ...UA, ...(o.headers || {}) }, signal: o.signal || AbortSignal.timeout(60000) });
export { realFetch };

export function loadEngine() {
  const src = fs.readFileSync(path.join(ROOT, 'engine', 'engine.js'), 'utf8');
  vm.runInThisContext(src, { filename: 'engine.js' });
  return globalThis.WS;
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const parseHTML = html => new DOMParser().parseFromString(html, 'text/html');
export { ROOT };
