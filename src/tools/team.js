// Any league team's roster (current and next period) with names, NHL team, position, status and salary, plus the
// league's draft-pick ownership. Usage: node src/tools/team.js "Ottawa Senators"  (or a Fantrax team id).
// Writes data/adhoc/team.json.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env.js';

const L = 'fs61ldkdmow7aw2h';
const want = (process.argv[2] || process.env.TEAM || 'Calgary Flames').toLowerCase();
const j = u => fetch(u).then(r => { if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); });
const info = await j(`https://www.fantrax.com/fxea/general/getLeagueInfo?leagueId=${L}`);
const teams = info.teamInfo || {};
const tid = Object.keys(teams).find(id => id.toLowerCase() === want || (teams[id].name || '').toLowerCase() === want) ;
if (!tid) throw new Error('team not found: ' + want + ' / ' + Object.values(teams).map(t => t.name).join(', '));
const ids = await j('https://www.fantrax.com/fxea/general/getPlayerIds?sport=NHL');
const cur = await j(`https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${L}`);
const nxt = await j(`https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${L}&period=${cur.period + 1}`).catch(() => null);
const rows = ro => (ro?.rosters[tid]?.rosterItems || []).map(i => { const p = ids[i.id] || {}; const [l, f] = (p.name || '').split(', '); return { id: i.id, name: f ? f + ' ' + l : (p.name || i.id), nhlTeam: p.team || null, pos: i.position, elig: p.position || null, status: i.status, salary: +(i.salary / 1e6).toFixed(3) }; });
let picks = null;
try { picks = await j(`https://www.fantrax.com/fxea/general/getDraftPicks?leagueId=${L}`); } catch (e) { picks = { err: String(e) }; }
const out = { at: new Date().toISOString(), team: teams[tid].name, teamId: tid, teamNames: Object.fromEntries(Object.entries(teams).map(([k, v]) => [k, v.name])), period: cur.period, current: rows(cur), next: rows(nxt), picks };
const dir = path.join(ROOT, 'data', 'adhoc'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify(out, null, 1));
console.log(out.team, out.current.length, 'players');
