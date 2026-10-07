// Weekly lineup check for HFD: roster for the current and next scoring period, each NHL team's games in the
// Monday-Sunday week that starts on the given date (default: this week's Monday, Toronto time), and each rostered NHL
// player's season-to-date fantasy points under league scoring. Game logs carry no hits or blocks; those are added from
// the NHL season report when it can be read (each player's `note` says whether they are in).
// Usage: node src/tools/week.js [YYYY-MM-DD]  (or env DATE / ARGS). Writes data/adhoc/week.json.
import { TEAM_ID, torontoDate, addDays, isDate, cliArgs, writeJSON } from '../lib/config.js';
import { getPlayerIds, rosterBundle, rosterRows } from '../lib/fantrax.js';
import { nhl, findNhlId, seasonHitsBlocks } from '../lib/nhl.js';
import { gameLogFP, SCORING, SCORING_TEXT } from '../lib/scoring.js';
import { fxSplit } from '../lib/names.js';

const today = torontoDate();
const mon = [process.env.DATE, ...cliArgs()].find(isDate) || addDays(today, -((new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7));

// Games per team, Monday to Sunday
const sched = await nhl(`schedule/${mon}`);
const games = {}, byDay = {};
for (const day of sched.gameWeek || []) for (const g of day.games || []) {
  if (g.gameType !== 2) continue;
  for (const t of [g.awayTeam.abbrev, g.homeTeam.abbrev]) { games[t] = (games[t] || 0) + 1; (byDay[t] = byDay[t] || []).push(day.date.slice(5)); }
}

// Rosters
const ids = await getPlayerIds();
const ro = await rosterBundle();
const cur = rosterRows(ro.cur, TEAM_ID, ids), next = ro.next ? rosterRows(ro.next, TEAM_ID, ids) : [];

// Season-to-date fantasy points from NHL game logs, plus hits and blocks from the season report
const hb = await seasonHitsBlocks();
async function fp(row) {
  const [first, last] = fxSplit(ids[row.id]?.name);
  const id = await findNhlId(row.nhlTeam, first, last);
  if (!id) return null;
  try {
    const g = await nhl(`player/${id}/game-log/now`);
    const log = (g.gameLog || []).filter(x => (x.gameTypeId || g.gameTypeId) === 2 || g.gameTypeId === 2);
    let pts = 0, gp = 0, goalie = false; const toi = [];
    for (const x of log) { gp++; pts += gameLogFP(x); if (x.shotsAgainst !== undefined || x.savePctg !== undefined) goalie = true; else toi.push(x.toi); }
    if (goalie || !gp) return { nhlId: id, gp, fp: +pts.toFixed(2), toi };
    const s = hb && hb[id];
    if (!s) return { nhlId: id, gp, fp: +pts.toFixed(2), toi, note: 'hits/blocks not in game log' };
    return { nhlId: id, gp, fp: +(pts + SCORING.HIT * s.hit + SCORING.BLK * s.blk).toFixed(2), hit: s.hit, blk: s.blk, toi, note: 'includes hits and blocks (NHL season report)' };
  } catch (e) { return { nhlId: id, err: String(e) }; }
}
const out = { at: new Date().toISOString(), week: mon, period: ro.period, scoring: SCORING_TEXT, hitsBlocks: hb ? 'included' : 'not available (season report could not be read)', games, byDay, current: cur, next };
for (const r of [...out.current, ...out.next]) { r.games = games[r.nhlTeam] || 0; r.days = byDay[r.nhlTeam] || []; }
const stat = {};
for (const r of [...out.current, ...out.next]) if (!(r.id in stat)) stat[r.id] = await fp(r);
out.stats = stat;
writeJSON('data/adhoc/week.json', out, 1);
console.log('period', ro.period, 'teams with games', Object.keys(games).length, 'current', out.current.length, 'next', out.next.length, 'hits/blocks', out.hitsBlocks);
