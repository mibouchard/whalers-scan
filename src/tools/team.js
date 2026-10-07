// Any league team's roster (current and next period) with names, NHL team, position, status and salary, plus the
// league's draft-pick ownership. Usage: node src/tools/team.js "Ottawa Senators"   (a team name, short code such as OTT,
// or Fantrax team id; also via env TEAM or ARGS). Writes data/adhoc/team.json.
import { TEAMS, cliArgs, writeJSON } from '../lib/config.js';
import { getLeagueInfo, getPlayerIds, getDraftPicks, rosterBundle, rosterRows, capOf } from '../lib/fantrax.js';

// `team Ottawa Senators` (unquoted, from the workflow's args box) and `team "Ottawa Senators"` both work
const want = (process.env.TEAM || cliArgs().join(' ') || 'Calgary Flames').trim().toLowerCase();
const info = await getLeagueInfo();
const teams = info.teamInfo || {};
const tid = Object.keys(teams).find(id => id.toLowerCase() === want || (teams[id].name || '').toLowerCase() === want || (TEAMS[id] || '').toLowerCase() === want);
if (!tid) throw new Error('team not found: ' + want + ' / ' + Object.values(teams).map(t => t.name).join(', '));
const ids = await getPlayerIds();
const ro = await rosterBundle();
let picks = null;
try { picks = await getDraftPicks(); } catch (e) { picks = { err: String(e) }; }
const out = { at: new Date().toISOString(), team: teams[tid].name, teamId: tid, short: TEAMS[tid] || null, teamNames: Object.fromEntries(Object.entries(teams).map(([k, v]) => [k, v.name])), period: ro.period, nextPeriod: ro.nextPeriod,
  current: rosterRows(ro.cur, tid, ids), next: ro.next ? rosterRows(ro.next, tid, ids) : [], cap: capOf((ro.next || ro.cur).rosters[tid]?.rosterItems || [], TEAMS[tid]), picks, notes: ro.notes };
writeJSON('data/adhoc/team.json', out, 1);
console.log(out.team, out.current.length, 'players');
