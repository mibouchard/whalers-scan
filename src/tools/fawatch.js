// Minors free-agent watch: every league's skaters and goalies who are 24 or younger (or of unknown age, or older but
// carrying the league's minors-eligible badge: see src/lib/minors.js), are a free agent
// or on waivers in our league per Fantrax's own status (getLeagueInfo), and either hold NHL rights (rights: true) or are
// known from a real birthdate to have been passed over in an NHL draft (rights: false, dr 'post'). Players not yet through
// a draft, and players whose draft status is unknown (no real birthdate), are never included without NHL rights.
// Counts players from their first game and ranks across leagues by gem score, rows with a known age first
// (ageKnown: false = the league publishes no age: not an ordinary under-24 target, verify first).
// The same matching guards and cross-league plausibility check as the daily scan apply (src/lib/plausible.js).
//
// Inside the daily workflow it reuses the rows the scan just collected; run on its own it reads every league itself.
// A league with no fresh rows keeps its previous fawatch rows for up to 7 days (status "carried <date>").
// Writes data/adhoc/fawatch.json: { at, src, status: { <league>: ... }, errors: { <league>: reason }, skaters: [...], goalies: [...] }.
import { loadEngine } from '../env.js';
import { torontoDate, readJSON, writeJSON } from '../lib/config.js';
import { getLeagueInfo } from '../lib/fantrax.js';
import { LEAGUES, collectLeagues, checkRows, loadRows } from '../lib/pipeline.js';
import { akFor } from '../lib/plausible.js';
import { minorsEligible } from '../lib/minors.js';

const WS = loadEngine();
const today = torontoDate();
const info = await getLeagueInfo();
const pinfo = info.playerInfo; if (!pinfo) throw new Error('getLeagueInfo has no playerInfo: free-agent status unknown, fawatch not written');
const free = id => ['FA', 'WW'].includes(pinfo[id]?.status);

let rowsBy = {}, status = {}, errors = {}, src;
const cache = loadRows();
if (cache && cache.d === today && !process.env.FAWATCH_FRESH) {
  src = 'rows from the daily scan at ' + cache.at; rowsBy = cache.leagues;
  for (const lg of LEAGUES) { if (cache.errors?.[lg]) errors[lg] = cache.errors[lg]; status[lg] = rowsBy[lg] ? (cache.status?.[lg] || 'ok') : (cache.status?.[lg] === 'no games yet' ? 'no games yet' : 'ERR ' + (cache.errors?.[lg] || 'no rows')); }
} else {
  src = 'own fetch';
  const fx = await WS.fantrax();
  for (const [id, v] of Object.entries(pinfo)) if (v?.eligiblePos) fx.elig[id] = v.eligiblePos;
  const run = await collectLeagues(WS, { fx, log: console.log, budgetMs: 13 * 60000, hadRows: lg => WS.histTotals(lg).some(t => t[1] > 0) });
  checkRows(WS, fx, run.collected, [], { save: false });
  for (const [lg, c] of Object.entries(run.collected)) { WS.trend(lg, c.rows); rowsBy[lg] = c.rows; status[lg] = c.meta.partial ? 'partial: ' + c.meta.partial : 'ok'; if (c.meta.partial) errors[lg] = 'partial: ' + c.meta.partial; }
  for (const lg of run.empty) status[lg] = 'no games yet';
  for (const [lg, why] of Object.entries(run.failed)) { errors[lg] = why; status[lg] = 'ERR ' + why.slice(0, 160); }
}

const obj = (cols, s) => Object.fromEntries(s.split('|').map((v, i) => [cols[i], v === '' ? null : isNaN(v) ? v : +v]));
// The M badge beats the age ceiling (src/lib/minors.js). Asked for every free player the ceiling would drop who could
// matter: any NHL free agent with a game, and any 25-27-year-old elsewhere whose line already scores like a target.
const MAX_AGE = 24;
const overAge = r => r.fx && !r.own && r.gp >= 1 && free(r.fx) && r.mq !== 'amb' && r.age != null && r.age > MAX_AGE;
const askIds = [];
for (const lg of LEAGUES) for (const r of rowsBy[lg] || []) if (overAge(r) && (lg === 'NHL' || (r.age <= 27 && (r.nhle || 0) >= 20))) askIds.push(r.fx);
const badge = await minorsEligible(askIds, { log: console.log, budgetMs: 3 * 60000 });
const minors = id => badge[id];
const out = { at: new Date().toISOString(), src, status, errors, badge: { asked: askIds.length, eligible: askIds.filter(id => badge[id] === true).length, unchecked: askIds.filter(id => badge[id] === undefined).length }, skaters: [], goalies: [] };
for (const lg of LEAGUES) {
  const rows = rowsBy[lg]; if (!rows) continue;
  const r = WS.summarize(lg, rows, { minGP: 1, maxAge: MAX_AGE, nAvail: 80, undMaxAge: 24, nUnd: 40, nGoalies: 14, free, minors });
  // avail = NHL rights held by a club. und = no NHL club: only players a real birthdate shows were already passed over in
  // an NHL draft (dr 'post') can be claimed; not yet through a draft ('pre') or unknown ('') are left out.
  for (const [list, rights] of [[r.avail, true], [r.undrafted.filter(s => obj(WS.SK, s).dr === 'post'), false]]) for (const s of list) {
    const o = obj(WS.SK, s); const st = pinfo[o.fx]?.status;
    const af = Math.max(.6, Math.min(1.4, 1 + .1 * (21 - (o.age ?? 21))));
    const row = { lg, ...o, ageKnown: o.ak != null, rights, fxStatus: st, elig: pinfo[o.fx]?.eligiblePos, gem: +((o.nhle || 0) * af * (/D/.test(o.pos) ? 1.3 : 1)).toFixed(1) };
    // over the age ceiling and in the list only because of his M badge: say so, so the review judges him as an NHL add
    if (o.age != null && o.age > MAX_AGE) { row.overAge = true; row.minors = badge[o.fx] ?? null; }
    out.skaters.push(row);
  }
  for (const s of r.goalies) { const o = obj(WS.GK, s); if (o.own) continue; const row = { lg, ...o, ageKnown: o.ak != null, fxStatus: pinfo[o.fx]?.status }; if (o.age != null && o.age > MAX_AGE) { row.overAge = true; row.minors = badge[o.fx] ?? null; } out.goalies.push(row); }
}
// leagues with nothing fresh: carry their previous rows (still free agents per today's Fantrax status), at most a week old
const prev = readJSON('data/adhoc/fawatch.json');
for (const lg of LEAGUES) {
  if (rowsBy[lg] || status[lg] === 'no games yet' || !prev) continue;
  const m = /^carried (\d{4}-\d{2}-\d{2})/.exec(prev.status?.[lg] || ''); const from = m ? m[1] : /^(ok|partial)/.test(prev.status?.[lg] || '') ? torontoDate(new Date(prev.at)) : null;
  if (!from || (Date.parse(today) - Date.parse(from)) / 864e5 > 7) continue;
  // (rows saved before the ak column existed get it from the league; without NHL rights only a real birthdate counts)
  const keep = x => x.lg === lg && free(x.fx) && (x.rights !== false || (x.ak ?? akFor(lg, x.age)) === 'dob');
  const again = x => ({ ...x, ageKnown: x.ageKnown ?? x.age != null, fxStatus: pinfo[x.fx]?.status });
  out.skaters.push(...(prev.skaters || []).filter(keep).map(again)); out.goalies.push(...(prev.goalies || []).filter(keep).map(again));
  status[lg] = 'carried ' + from;
}
// rows with a known age first, then by gem
out.skaters.sort((a, b) => (b.ageKnown !== false) - (a.ageKnown !== false) || b.gem - a.gem);
writeJSON('data/adhoc/fawatch.json', out);
console.log(src, '|', out.skaters.length, 'skaters', out.goalies.length, 'goalies |', Object.entries(status).filter(([, v]) => v !== 'ok').map(([k, v]) => k + ': ' + v).join('; ') || 'all leagues ok');
