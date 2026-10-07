// Runtime for the scan and the tools: browser-like globals so engine/engine.js runs in Node, a file-backed localStorage
// under state/ (caches and the 22-day trend history survive between runs because the workflow commits state/), and a
// fetch with a browser user agent, per-host cookies, a 60 s timeout and an optional per-league abort signal.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { DOMParser } from 'linkedom';
import { ROOT, LEAGUE_ID, TEAMS, NHL_TEAMS } from './lib/config.js';
import * as NAMES from './lib/names.js';
import { retry, sleep } from './lib/util.js';

const STATE = process.env.WS_STATE_DIR || path.join(ROOT, 'state'); // WS_STATE_DIR: tests point this at a temp folder
// keys that are only same-day caches: kept in memory, never written to the repo
const VOLATILE = [/^ws\.tmp\./];
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

export const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7', 'Sec-Fetch-Mode': 'navigate', 'Upgrade-Insecure-Requests': '1' };
const nodeFetch = globalThis.fetch;
// Cookie jar per host + manual redirects: some sites (khl.ru) set a cookie and redirect back to the same page, which loops
// forever unless the cookie is sent on the next hop.
const jar = new Map();
const cookieFor = host => [...(jar.get(host) || new Map())].map(([k, v]) => k + '=' + v).join('; ');
const keep = (host, res) => { const m = jar.get(host) || new Map(); for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) m.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); } jar.set(host, m); };
export const cookieHeader = u => cookieFor(new URL(u).host);
async function realFetch(u, o = {}) {
  let url = String(u), method = o.method || 'GET', body = o.body;
  for (let hop = 0; hop < 10; hop++) {
    const host = new URL(url).host; const c = cookieFor(host);
    const headers = { ...(o.headers || {}) }; if (c && !headers.Cookie) headers.Cookie = c;
    const res = await nodeFetch(url, { ...o, method, body, headers, redirect: 'manual' });
    keep(host, res);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).href; if (res.status !== 307 && res.status !== 308) { method = 'GET'; body = undefined; } continue;
    }
    return res;
  }
  throw new Error('too many redirects: ' + u);
}
// The scan sets a signal while one league is being read (src/scan.js, per-league deadline): when it aborts, every request
// that league still has in flight stops, so a slow league cannot hold the job.
let leagueSignal = null;
export const setLeagueSignal = s => { leagueSignal = s || null; };
export const timeoutSignal = (ms = 60000) => leagueSignal ? AbortSignal.any([AbortSignal.timeout(ms), leagueSignal]) : AbortSignal.timeout(ms);
// every request gets a browser user agent, cookies and a timeout
globalThis.fetch = (u, o = {}) => realFetch(u, { ...o, headers: { ...UA, ...(o.headers || {}) }, signal: o.signal || timeoutSignal() });
export { realFetch };

// The engine is a classic script: it reads the shared helpers from window.WS_LIB (one name normaliser, one team map).
export function loadEngine() {
  globalThis.WS_LIB = { ...NAMES, retry, LEAGUE_ID, TEAMS, NHL_TEAMS };
  const src = fs.readFileSync(path.join(ROOT, 'engine', 'engine.js'), 'utf8');
  vm.runInThisContext(src, { filename: 'engine.js' });
  return globalThis.WS;
}
export { sleep };
export const parseHTML = html => new DOMParser().parseFromString(html, 'text/html');
export { ROOT };
