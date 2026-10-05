// Weekly lineup check for Fred (HFD): roster for the current and next scoring period, plus each NHL team's games
// in the Monday-Sunday week that starts on the given date (default: this week's Monday, Toronto time), and each
// rostered NHL player's season-to-date fantasy points under league scoring (from NHL game logs).
// Usage: node src/tools/week.js [YYYY-MM-DD]. Writes data/adhoc/week.json.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env.js';

const L = 'fs61ldkdmow7aw2h', HFD = 'm1hfr04lmow7aw2v';
const j = u => fetch(u).then(r => { if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); });
const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
const mon = process.argv[2] || (() => { const d = new Date(today); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();

// Games per team, Monday to Sunday
const sched = await j(`https://api-web.nhle.com/v1/schedule/${mon}`);
const games = {}, byDay = {};
for (const day of sched.gameWeek || []) for (const g of day.games || []) {
  if (g.gameType !== 2) continue;
  for (const t of [g.awayTeam.abbrev, g.homeTeam.abbrev]) { games[t] = (games[t] || 0) + 1; (byDay[t] = byDay[t] || []).push(day.date.slice(5)); }
}

// Rosters
const ids = await j('https://www.fantrax.com/fxea/general/getPlayerIds?sport=NHL');
const cur = await j(`https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${L}`);
const nxt = await j(`https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${L}&period=${cur.period + 1}`).catch(() => null);
const rows = ro => (ro?.rosters[HFD]?.rosterItems || []).map(i => { const p = ids[i.id] || {}; const [l, f] = (p.name || '').split(', '); return { id: i.id, name: f ? f + ' ' + l : (p.name || i.id), nhlTeam: p.team || null, pos: i.position, elig: p.position || null, status: i.status, salary: +(i.salary / 1e6).toFixed(3) }; });

// Season-to-date fantasy points from NHL game logs (team rosters give NHL player ids)
const S = 'G 3, A 2, PPP 1, SHG 2, GWG 1, +/- 0.5, BLK 0.2, HIT 0.2, PIM 0.25, SOG 0.1; G: W 5, SO 5, SV 0.25, GA -1';
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['.\-]/g, '').toLowerCase().split(/\s+/).sort().join(' ');
const nhlIds = {};
const teams = [...new Set([...rows(cur), ...rows(nxt)].map(r => r.nhlTeam).filter(Boolean))];
for (const t of teams) {
  try {
    const r = await j(`https://api-web.nhle.com/v1/roster/${t}/current`);
    for (const p of [...(r.forwards || []), ...(r.defensemen || []), ...(r.goalies || [])]) nhlIds[t + '|' + norm(p.firstName.default + ' ' + p.lastName.default)] = p.id;
  } catch (e) { }
}
async function fp(row) {
  const id = nhlIds[row.nhlTeam + '|' + norm(row.name)];
  if (!id) return null;
  try {
    const g = await j(`https://api-web.nhle.com/v1/player/${id}/game-log/now`);
    const log = (g.gameLog || []).filter(x => (x.gameTypeId || g.gameTypeId) === 2 || g.gameTypeId === 2);
    let pts = 0, gp = 0, toi = [];
    for (const x of log) {
      gp++;
      if (x.savePctg !== undefined || x.shotsAgainst !== undefined) {
        const sv = (x.shotsAgainst || 0) - (x.goalsAgainst || 0);
        pts += (x.decision === 'W' ? 5 : 0) + (x.shutouts ? 5 : 0) + sv * 0.25 - (x.goalsAgainst || 0);
      } else {
        pts += 3 * (x.goals || 0) + 2 * (x.assists || 0) + (x.powerPlayPoints || 0) + 2 * (x.shorthandedGoals || 0) + (x.gameWinningGoals || 0) + 0.5 * (x.plusMinus || 0) + 0.25 * (x.pim || 0) + 0.1 * (x.shots || 0);
        toi.push(x.toi);
      }
    }
    return { nhlId: id, gp, fp: +pts.toFixed(2), toi, note: 'hits/blocks not in game log' };
  } catch (e) { return { nhlId: id, err: String(e) }; }
}
const out = { at: new Date().toISOString(), week: mon, period: cur.period, scoring: S, games, byDay, current: rows(cur), next: rows(nxt) };
for (const r of [...out.current, ...out.next]) { r.games = games[r.nhlTeam] || 0; r.days = byDay[r.nhlTeam] || []; }
const stat = {};
for (const r of out.current) stat[r.id] = await fp(r);
for (const r of out.next) if (!(r.id in stat)) stat[r.id] = await fp(r);
out.stats = stat;
const dir = path.join(ROOT, 'data', 'adhoc'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'week.json'), JSON.stringify(out, null, 1));
console.log('period', cur.period, 'teams with games', Object.keys(games).length, 'current', out.current.length, 'next', out.next.length);
