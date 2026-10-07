// Fantrax public feed (https://www.fantrax.com/fxea/general/...) for The Hockey Life, plus the league's roster and cap rules.
// No login, no cookies, no secrets: these endpoints are public for a public league.
//
// The period rule: a claim, drop or lineup move made this week only shows in next period's roster. So ownership, counts,
// cap and "next week" questions use period N+1 (falling back to N at the end of the season or if the fetch fails);
// scoring a game that was already played uses the period in effect when it was played (periodForDate).
import '../env.js';
import { LEAGUE_ID, TEAM_ID, CAP, DEAD_CAP, TEAMS, LIMITS, short, torontoInstant, isDate } from './config.js';
import { getJSONr, errText } from './util.js';
import { fxDisplay } from './names.js';

const B = 'https://www.fantrax.com/fxea/general/';
export const getLeagueInfo = () => getJSONr(`${B}getLeagueInfo?leagueId=${LEAGUE_ID}`);
export const getPlayerIds = () => getJSONr(`${B}getPlayerIds?sport=NHL`);
export const getAdp = () => getJSONr(`${B}getAdp?sport=NHL`);
export const getStandings = () => getJSONr(`${B}getStandings?leagueId=${LEAGUE_ID}`);
export const getMatchupScores = period => getJSONr(`${B}getMatchupScores?leagueId=${LEAGUE_ID}${period ? '&period=' + period : ''}`);
export const getDraftPicks = () => getJSONr(`${B}getDraftPicks?leagueId=${LEAGUE_ID}`);
export async function getRosters(period) {
  const j = await getJSONr(`${B}getTeamRosters?leagueId=${LEAGUE_ID}${period ? '&period=' + period : ''}`);
  if (!j || !j.rosters) throw new Error('getTeamRosters: no rosters in the response');
  return j;
}

// Current (N) and next (N+1) rosters. next is null when Fantrax has no later period (it then answers with the last
// period it has) or when the fetch fails; notes says which.
export async function rosterBundle() {
  const cur = await getRosters(); const notes = []; let next = null;
  try {
    const nx = await getRosters((cur.period || 0) + 1);
    if (nx.period === (cur.period || 0) + 1) next = nx; else notes.push(`no period ${(cur.period || 0) + 1} rosters (Fantrax answered with period ${nx.period}): using period ${cur.period}`);
  } catch (e) { notes.push(`next-period rosters failed (${errText(e)}): using period ${cur.period}`); }
  return { cur, next, own: next || cur, period: cur.period, nextPeriod: next ? next.period : null, notes };
}

const items = (ro, tid) => ro?.rosters?.[tid]?.rosterItems || [];
export const salaryM = i => +((+i.salary || 0) / 1e6).toFixed(3);
// id -> { team (short code), teamId, st, sal } for every rostered player
export function ownership(ro) {
  const m = {};
  for (const [tid, t] of Object.entries(ro?.rosters || {})) for (const i of t.rosterItems || []) m[i.id] = { team: short(tid), teamId: tid, st: i.status, sal: salaryM(i) };
  return m;
}
export function counts(list) {
  const c = { active: 0, reserve: 0, ir: 0, minors: 0 };
  for (const i of list) { if (i.status === 'ACTIVE') c.active++; else if (i.status === 'RESERVE') c.reserve++; else if (i.status === 'INJURED_RESERVE') c.ir++; else if (i.status === 'MINORS') c.minors++; }
  c.main = c.active + c.reserve; return c;
}
// The one cap helper. The cap counts ACTIVE + RESERVE salaries plus the team's dead cap (config.json deadCap);
// MINORS and INJURED_RESERVE do not count. roomAfterIR = room left if every injured-reserve player came back.
export function capOf(list, teamShort) {
  const sum = st => list.filter(i => i.status === st).reduce((s, i) => s + (+i.salary || 0) / 1e6, 0);
  const active = sum('ACTIVE'), reserve = sum('RESERVE'), ir = sum('INJURED_RESERVE'), dead = +DEAD_CAP[teamShort] || 0;
  const used = active + reserve + dead; const r3 = x => +x.toFixed(3);
  return { cap: CAP, active: r3(active), reserve: r3(reserve), dead: r3(dead), ir: r3(ir), used: r3(used), room: r3(CAP - used), roomAfterIR: r3(CAP - used - ir) };
}
export const teamCap = (ro, tid) => capOf(items(ro, tid), short(tid));
export const teamCounts = (ro, tid) => counts(items(ro, tid));
export function rosterWarnings(c, cap) {
  const w = [];
  if (c.minors > LIMITS.minorsMax) w.push(`minors ${c.minors}/${LIMITS.minorsMax}`);
  if (c.main > LIMITS.mainMax) w.push(`main roster ${c.main}/${LIMITS.mainMax}`);
  if (c.main < LIMITS.mainMin) w.push(`main roster ${c.main}, minimum ${LIMITS.mainMin}`);
  if (c.active !== LIMITS.active) w.push(`active not ${LIMITS.active} (${c.active})`);
  if (c.reserve > LIMITS.reserveMax) w.push(`reserve ${c.reserve}/${LIMITS.reserveMax}`);
  if (cap && cap.room < 0) w.push(`over the cap by ${(-cap.room).toFixed(3)}M`);
  return w;
}

// Roster rows with names: { id, name, nhlTeam, pos, elig, status, salary }
export function rosterRows(ro, tid, ids, name = null) {
  return items(ro, tid).map(i => { const p = ids?.[i.id] || {}; return { id: i.id, name: name ? name(i.id) : (p.name ? fxDisplay(p.name) : i.id), nhlTeam: p.team || null, pos: i.position, elig: p.position || null, status: i.status, salary: salaryM(i) }; });
}
// id -> "First Last" from getPlayerIds, falling back to getAdp; null when neither knows the id
export function namer(ids, adp) {
  const a = {}; for (const x of Array.isArray(adp) ? adp : []) if (x && x.id && x.name) a[x.id] = x.name;
  return id => { const n = ids?.[id]?.name || a[id]; return n ? fxDisplay(n) : null; };
}

// ---- scoring periods ----
// getLeagueInfo lists every period with its start and end instant (periods change at the first puck drop of the week,
// usually Monday 7 PM ET). Returns [{ n, start, end }] sorted, or [] when the feed has no dates.
export function periods(info) {
  const src = info?.scoringPeriods || info?.rosterPeriods || info?.periods || [];
  return (Array.isArray(src) ? src : []).map(p => ({ n: +(p.number ?? p.period ?? p.id), start: Date.parse(String(p.startDate || p.start || '').replace(/\.\d+(?=[+-]\d{4}$)/, '')), end: Date.parse(String(p.endDate || p.end || '').replace(/\.\d+(?=[+-]\d{4}$)/, '')) }))
    .filter(p => p.n && !isNaN(p.start) && !isNaN(p.end)).sort((a, b) => a.start - b.start);
}
// The scoring period in effect for a game. `when` is a game's start time (Date or ISO instant) or a YYYY-MM-DD game
// date, which is read as that evening in Toronto. Returns the period number, or null when it cannot be told
// (no period dates in the feed, or outside the season).
export function periodForDate(when, info) {
  const P = periods(info); if (!P.length || when == null) return null;
  const t = when instanceof Date ? when.getTime() : isDate(when) ? torontoInstant(when, '23:00:00').getTime() : Date.parse(when);
  if (isNaN(t)) return null;
  const hit = P.find(p => t >= p.start && t <= p.end); if (hit) return hit.n;
  // a gap between two periods (the feed leaves a second or so): take the one that starts next
  const next = P.find(p => p.start > t); const prev = [...P].reverse().find(p => p.end < t);
  if (next && prev && next.start - prev.end < 36e5) return next.n;
  return null;
}
export function periodDates(n, info) {
  const p = periods(info).find(x => x.n === n); return p ? { start: new Date(p.start).toISOString(), end: new Date(p.end).toISOString() } : null;
}
// Free agents by Fantrax's own word: { id: 'FA' | 'WW' }. Never inferred from rosters.
export function freeMap(info) {
  if (!info || !info.playerInfo) return null;
  const m = {}; for (const [id, v] of Object.entries(info.playerInfo)) if (v && (v.status === 'FA' || v.status === 'WW')) m[id] = v.status;
  return m;
}
// What changed between two league.json `teams` maps (rows are [fxId, status, salaryM, pos, name, nhlTeam]; each team's
// next-period roster is compared, falling back to its current one): adds (from null), drops (to null), status changes
// and salary changes. A trade shows as a drop on one team and an add on the other.
export function diffMoves(prevTeams, teams) {
  const moves = []; const view = t => t ? (t.next || t.cur || null) : null;
  for (const [tid, t] of Object.entries(teams || {})) {
    const was = view(prevTeams?.[tid]), is = view(t); if (!was || !is) continue;
    const a = new Map(was.map(r => [r[0], r])), b = new Map(is.map(r => [r[0], r])); const team = t.short || short(tid);
    for (const [id, r] of b) { const o = a.get(id); if (!o) moves.push({ team, id, name: r[4] || null, from: null, to: r[1], salaryFrom: null, salaryTo: r[2] }); else if (o[1] !== r[1] || o[2] !== r[2]) moves.push({ team, id, name: r[4] || o[4] || null, from: o[1], to: r[1], salaryFrom: o[2], salaryTo: r[2] }); }
    for (const [id, o] of a) if (!b.has(id)) moves.push({ team, id, name: o[4] || null, from: o[1], to: null, salaryFrom: o[2], salaryTo: null });
  }
  return moves;
}
export { TEAM_ID, LEAGUE_ID, TEAMS };
