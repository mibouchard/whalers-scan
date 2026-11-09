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
// opts.max new lookups (default 400) and within opts.budgetMs (default 4 minutes), three at a time. Anything the budget
// leaves unfetched comes back as undefined (not null), so a caller can tell "not eligible" from "not checked".
export async function minorsEligible(ids, opts = {}) {
  const today = torontoDate();
  const C = readJSON(FILE, {}) || {};
  const fresh = e => e && e.d && days(today, e.d) <= (e.m == null ? KEEP_UNKNOWN_DAYS : KEEP_DAYS);
  const want = [...new Set(ids)].filter(Boolean);
  const todo = want.filter(id => !fresh(C[id])).slice(0, opts.max ?? 400);
  const t0 = Date.now(), budget = opts.budgetMs ?? 4 * 60000; let n = 0, fails = 0;
  for (let i = 0; i < todo.length && Date.now() - t0 < budget; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(async id => {
      try { const p = await readProfile(id); C[id] = { m: p.minors, d: today }; n++; }
      catch (e) { fails++; if (!C[id]) C[id] = { m: null, d: today, err: String(e.message || e).slice(0, 80) }; }
    }));
    await sleep(150);
  }
  if (n || fails) { writeJSON(FILE, C); opts.log?.(`minors badge: ${n} looked up, ${fails} failed, ${todo.length - Math.min(todo.length, n + fails)} left for next run, ${Object.keys(C).length} cached`); }
  const out = {};
  for (const id of want) { const e = C[id]; out[id] = e && fresh(e) ? e.m : e ? e.m : undefined; }
  return out;
}
