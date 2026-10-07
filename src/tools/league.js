// The whole league in one file, from Fantrax's public feed. Writes:
//   data/league.json        every team's roster for the current (N) and next (N+1) period, HFD counts / cap / IR / warnings,
//                           every free agent and waiver player, this period's matchup scores, standings, and what changed
//                           on any roster since the previous league.json (moves)
//   data/fo/rosters.json    ready-to-write Front Office doc: rosters as of the next period (falling back to the current one)
//   data/fo/scores.json     ready-to-write Front Office doc: this period's matchups
//   data/fo/standings.json  ready-to-write Front Office doc (only written when wins and losses are present)
// Each part is optional: a feed that fails is named under notes and its part is null (free agents are never inferred).
// Team keys are Fantrax team ids; `short` / a / h / team are the short codes (HFD, CGY, ...).
import { TEAM_ID, MY, DEAD_CAP, TEAMS, short, isoToronto, readJSON, writeJSON } from '../lib/config.js';
import { getLeagueInfo, getPlayerIds, getAdp, getStandings, getMatchupScores, rosterBundle, counts, capOf, rosterWarnings, salaryM, namer, periodDates, freeMap, diffMoves } from '../lib/fantrax.js';
import { errText } from '../lib/util.js';

const at = new Date().toISOString(), asOf = isoToronto();
const notes = [];
const part = async (label, fn) => { try { return await fn(); } catch (e) { notes.push(`${label}: ${errText(e)}`); return null; } };

const ro = await rosterBundle(); // throws when even the current rosters cannot be read: nothing useful to write then
notes.push(...ro.notes);
const [info, ids, adp, standings, scores] = await Promise.all([
  part('getLeagueInfo', getLeagueInfo), part('getPlayerIds', getPlayerIds), part('getAdp', getAdp), part('getStandings', getStandings), part('getMatchupScores', () => getMatchupScores()),
]);
const name = namer(ids, adp);
const row = i => [i.id, i.status, salaryM(i), i.position || '', name(i.id) || '', ids?.[i.id]?.team || ''];

// ---- teams ----
const teams = {};
for (const tid of new Set([...Object.keys(ro.cur.rosters), ...Object.keys(ro.next?.rosters || {})])) {
  const c = ro.cur.rosters[tid], n = ro.next?.rosters?.[tid];
  teams[tid] = { short: short(tid), name: info?.teamInfo?.[tid]?.name || (c || n).teamName || '', cur: (c?.rosterItems || []).map(row), next: n ? n.rosterItems.map(row) : null };
}

// ---- HFD ----
const pool = readJSON('data/pool.json');
const side = x => { const list = x?.rosters?.[TEAM_ID]?.rosterItems; if (!list) return null; const { cap: _cap, ...cap } = capOf(list, MY); return { counts: counts(list), cap }; };
const hfdNext = ro.next?.rosters?.[TEAM_ID]?.rosterItems || ro.cur.rosters[TEAM_ID]?.rosterItems || [];
const hfd = { cur: side(ro.cur), next: side(ro.next),
  ir: hfdNext.filter(i => i.status === 'INJURED_RESERVE').map(i => ({ id: i.id, name: name(i.id), salary: salaryM(i), ret: pool?.injuries?.rows?.[i.id]?.[3] || null })),
  warnings: [] };
// warnings are about the roster that counts for the next lock: next period's, or the current one when there is no next
{ const h = hfd.next || hfd.cur; if (h) hfd.warnings.push(...rosterWarnings(h.counts, h.cap)); }
if (!ro.cur.rosters[TEAM_ID]) notes.push(`team ${TEAM_ID} not in the roster feed`);
const unknownIds = [...new Set([...(ro.cur.rosters[TEAM_ID]?.rosterItems || []), ...hfdNext].map(i => i.id))].filter(id => !name(id));

// ---- free agents: Fantrax's own status only ----
const free = freeMap(info);
if (!free) notes.push('free agents unknown: getLeagueInfo has no playerInfo (free is null; nothing is inferred)');

// ---- scores and standings ----
const num = v => (v == null || isNaN(+v)) ? null : +v;
let sc = null;
if (scores && Array.isArray(scores.matchups)) sc = { period: scores.period ?? ro.period, matchups: scores.matchups.map(m => ({ a: short(m.away?.teamId), h: short(m.home?.teamId), as: num(m.away?.score), hs: num(m.home?.score) })) };
else {
  // pairings without scores from the schedule in getLeagueInfo
  const m = (info?.matchups || []).find(x => x.period === ro.period);
  if (m) { sc = { period: ro.period, matchups: (m.matchupList || []).map(x => ({ a: x.away?.shortName || short(x.away?.id), h: x.home?.shortName || short(x.home?.id), as: null, hs: null })) }; notes.push('scores: getMatchupScores gave no matchups; pairings are from the schedule, without scores'); }
}
let st = null;
if (Array.isArray(standings) && standings.length) {
  const rows = standings.map(s => {
    const [w, l, t] = String(s.points ?? '').split('-').map(x => (x === '' || isNaN(+x)) ? null : +x);
    return { team: short(s.teamId), w: num(s.wins) ?? w ?? null, l: num(s.losses) ?? l ?? null, t: num(s.ties) ?? t ?? null, pf: num(s.totalPointsFor ?? s.pointsFor), pa: num(s.totalPointsAgainst ?? s.pointsAgainst), rank: num(s.rank) };
  });
  st = { rows };
} else if (standings) notes.push('standings: unexpected shape');

// ---- moves: every team's next-period roster against the previous league.json ----
const prev = readJSON('data/league.json');
const moves = prev?.teams ? diffMoves(prev.teams, teams) : [];
if (!prev?.teams) notes.push('moves: no previous league.json to compare with');

const out = { at, period: ro.period, nextPeriod: ro.nextPeriod, periodDates: { cur: periodDates(ro.period, info), next: ro.nextPeriod ? periodDates(ro.nextPeriod, info) : null },
  teams, hfd, free, scores: sc, standings: st, moves, movesSince: prev?.at || null, unknownIds, notes };

// ---- Front Office docs ----
const rp = ro.nextPeriod || ro.period; const foTeams = {}; const dead = {};
for (const [tid, t] of Object.entries(teams)) {
  const rows = (t.next || t.cur).map(r => r.slice(0, 5));
  if (rows.length < 25) { notes.push(`fo/rosters: ${t.short} left out (${rows.length} players, expected 25 or more)`); continue; }
  foTeams[tid] = rows;
}
for (const [tid, code] of Object.entries(TEAMS)) if (DEAD_CAP[code] != null) dead[tid] = DEAD_CAP[code];
writeJSON('data/fo/rosters.json', { asOf, src: 'Fantrax getTeamRosters', period: rp, teams: foTeams, dead });
if (sc) writeJSON('data/fo/scores.json', { asOf, period: sc.period, matchups: sc.matchups });
if (st && st.rows.some(r => r.w != null && r.l != null && (r.w || r.l))) writeJSON('data/fo/standings.json', { asOf, rows: st.rows });
else if (st) notes.push('fo/standings: not written (no wins or losses yet)');
writeJSON('data/league.json', out);
console.log(`period ${ro.period}/${ro.nextPeriod ?? '-'} | teams ${Object.keys(teams).length} | free ${free ? Object.keys(free).length : 'UNKNOWN'} | moves ${moves.length} | HFD ${hfd.next ? JSON.stringify(hfd.next.counts) : '-'} room ${hfd.next?.cap.room ?? hfd.cur?.cap.room} | warnings ${hfd.warnings.length}${notes.length ? ' | ' + notes.join('; ') : ''}`);
