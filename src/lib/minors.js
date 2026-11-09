// Minors eligibility (the M badge) for The Hockey Life, read from the Fantrax league player profile
// (fxpa getPlayerProfile, leagueData "Minors": Eligible / Not Eligible) and cached in state/ws.minors.json.
//
// Why this exists: the free-agent screens used to stop at age 24 (prospect pool) and 25 (night alert). The badge, not
// the age, is what lets a player sit in the minors, and the league has badged NHL players at 25 and 26 (Maxim Shabanov,
// 26, dropped by Ottawa on Oct 24, 2026 and claimed by Chicago 37 hours later while every screen ignored him for his
// age; Judd Caulfield, 25, Nov 2). So every screen now asks the badge for any free agent an age filter would drop.
//
// The badge is league-managed and changes rarely: an answer is kept 14 days, "unknown" (profile unreadable) 2 days.
import { torontoDate, readJSON, writeJSON } from './config.js';
import { LEAGUE_ID } from './config.js';
import { retry, sleep } from './util.js';

const FILE = 'state/ws.minors.json';
const KEEP_DAYS = 14, KEEP_UNKNOWN_DAYS = 2;
const days = (a, b) => (Date.parse(a) - Date.parse(b)) / 864e5;

export async function readProfile(id) {
  const body = JSON.stringify({ msgs: [{ method: 'getPlayerProfile', data: { leagueId: LEAGUE_ID, playerId: id } }] });
  const j = await retry(() => fetch(`https://www.fantrax.com/fxpa/req?leagueId=${LEAGUE_ID}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).then(r => { if (!r.ok) throw new Error(r.status + ' getPlayerProfile'); return r.json(); }), 3);
  const md = j?.responses?.[0]?.data?.miscData; if (!md) throw new Error('getPlayerProfile: no miscData for ' + id);
  const ld = Object.fromEntries((md.leagueData || []).map(x => [x.name, x.value]));
  const m = ld.Minors; // "Eligible" | "Not Eligible" | undefined
  return { minors: m === 'Eligible' ? true : m === 'Not Eligible' ? false : null, status: ld['Status/Team'] || null, icons: (md.icons || []).map(i => i.tooltip || '') };
}

// ids -> { [id]: true | false | null }. Cached answers are used as they are; missing or stale ones are fetched, at most
// opts.max new lookups (default 400) and within opts.budgetMs (default 4 minutes), one at a time with a short pause:
// Fantrax answers a burst from GitHub's runner with a thinned profile (no miscData), which the first CI run on Nov 8,
// 2026 saw for 370 of 400 calls. A failed lookup is never cached, so it is asked again next run; after 6 failures in a
// row the run pauses 10 s, and after 12 it stops asking. Anything left unasked comes back as undefined (not null), so a
// caller can tell "not eligible" from "not checked". ids are asked in the order given: put the ones that matter first.
export async function minorsEligible(ids, opts = {}) {
  const today = torontoDate();
  const C = readJSON(FILE, {}) || {};
  for (const [id, e] of Object.entries(C)) if (e && e.err) delete C[id]; // entries from before failures stopped being cached
  const fresh = e => e && e.d && days(today, e.d) <= (e.m == null ? KEEP_UNKNOWN_DAYS : KEEP_DAYS);
  const want = [...new Set(ids)].filter(Boolean);
  const todo = want.filter(id => !fresh(C[id])).slice(0, opts.max ?? 400);
  const t0 = Date.now(), budget = opts.budgetMs ?? 4 * 60000; let n = 0, fails = 0, streak = 0, stopped = false;
  for (const id of todo) {
    if (Date.now() - t0 >= budget) break;
    try { const p = await readProfile(id); C[id] = { m: p.minors, d: today }; n++; streak = 0; }
    catch (e) {
      fails++; streak++;
      if (streak === 6) { opts.log?.('minors badge: 6 failures in a row, pausing 10 s'); await sleep(10000); }
      if (streak >= 12) { stopped = true; opts.log?.('minors badge: 12 failures in a row, stopping for this run (' + String(e.message || e).slice(0, 80) + ')'); break; }
    }
    await sleep(opts.pauseMs ?? 400);
  }
  if (n) writeJSON(FILE, C);
  if (n || fails) opts.log?.(`minors badge: ${n} looked up, ${fails} failed${stopped ? ' (stopped early)' : ''}, ${todo.length - n} left for next run, ${Object.keys(C).length} cached`);
  const out = {};
  for (const id of want) { const e = C[id]; out[id] = e ? e.m : undefined; }
  return out;
}
