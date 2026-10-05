// Recent form for every NHL player on Fred's (HFD) Fantrax roster: fantasy points per game over his last 5 regular-season
// games in league scoring (G 3, A 2, PPP 1, SHG 2, GWG 1, +/- 0.5, BLK 0.2, HIT 0.2, PIM 0.25, SOG 0.1;
// goalies W 5, SO 5, SV 0.25, GA -1). Game logs give everything except hits and blocks, which come from each game's box score.
// Writes data/form.json: { at, window, players: { <fantraxId>: { name, gp, fpg, games: [[date, fp], ...] } } }.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env.js';

const L = 'fs61ldkdmow7aw2h', HFD = 'm1hfr04lmow7aw2v', N = 5;
const j = u => fetch(u).then(r => { if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); });
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['.\-]/g, '').toLowerCase().split(/\s+/).sort().join(' ');

const ids = await j('https://www.fantrax.com/fxea/general/getPlayerIds?sport=NHL');
const cur = await j(`https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${L}`);
const nxt = await j(`https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${L}&period=${cur.period + 1}`).catch(() => null);
const items = new Map();
for (const ro of [cur, nxt]) for (const i of ro?.rosters[HFD]?.rosterItems || []) {
  const p = ids[i.id] || {}; const [l, f] = (p.name || '').split(', ');
  if (!items.has(i.id)) items.set(i.id, { id: i.id, name: f ? f + ' ' + l : (p.name || i.id), team: p.team, goalie: (p.position || '').includes('G') });
}

const nhl = {};
for (const t of new Set([...items.values()].map(r => r.team).filter(Boolean))) {
  try {
    const r = await j(`https://api-web.nhle.com/v1/roster/${t}/current`);
    for (const p of [...(r.forwards || []), ...(r.defensemen || []), ...(r.goalies || [])]) nhl[t + '|' + norm(p.firstName.default + ' ' + p.lastName.default)] = p.id;
  } catch (e) { }
}

const box = new Map();
async function hitsBlocks(gameId, pid) {
  if (!box.has(gameId)) box.set(gameId, j(`https://api-web.nhle.com/v1/gamecenter/${gameId}/boxscore`).catch(() => null));
  const b = await box.get(gameId); if (!b) return null;
  for (const side of ['awayTeam', 'homeTeam']) for (const g of ['forwards', 'defense']) for (const s of b.playerByGameStats?.[side]?.[g] || [])
    if (s.playerId === pid) return { hits: s.hits || 0, blk: s.blockedShots || 0 };
  return null;
}

const out = { at: new Date().toISOString(), window: N, scoring: 'league', players: {} };
for (const r of items.values()) {
  const pid = nhl[r.team + '|' + norm(r.name)]; if (!pid) continue;
  let log;
  try { log = (await j(`https://api-web.nhle.com/v1/player/${pid}/game-log/now`)).gameLog || []; } catch (e) { continue; }
  log = log.filter(x => String(x.gameId).slice(4, 6) === '02').slice(0, N); // regular season, newest first
  if (!log.length) continue;
  const games = [];
  for (const x of log) {
    let fp;
    if (r.goalie || x.shotsAgainst !== undefined) {
      const sv = (x.shotsAgainst || 0) - (x.goalsAgainst || 0);
      fp = (x.decision === 'W' ? 5 : 0) + (x.shutouts ? 5 : 0) + 0.25 * sv - (x.goalsAgainst || 0);
    } else {
      const hb = await hitsBlocks(x.gameId, pid) || { hits: 0, blk: 0 };
      fp = 3 * (x.goals || 0) + 2 * (x.assists || 0) + (x.powerPlayPoints || 0) + 2 * (x.shorthandedGoals || 0) + (x.gameWinningGoals || 0)
        + 0.5 * (x.plusMinus || 0) + 0.25 * (x.pim || 0) + 0.1 * (x.shots || 0) + 0.2 * hb.hits + 0.2 * hb.blk;
    }
    games.push([x.gameDate, +fp.toFixed(2)]);
  }
  out.players[r.id] = { name: r.name, nhlId: pid, gp: games.length, fpg: +(games.reduce((s, g) => s + g[1], 0) / games.length).toFixed(2), games };
}
fs.writeFileSync(path.join(ROOT, 'data', 'form.json'), JSON.stringify(out, null, 1));
console.log('form for', Object.keys(out.players).length, 'players');
