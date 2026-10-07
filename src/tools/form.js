// Recent form for every NHL player on the HFD Fantrax roster (current and next period): fantasy points per game over his
// last 5 regular-season games in league scoring (src/lib/scoring.js). Game logs give everything except hits and blocks,
// which come from each game's box score.
// Writes data/form.json: { at, window, scoring, players: { <fantraxId>: { name, nhlId, gp, fpg, games: [[date, fp], ...] } },
//                          roster: { <fantraxId>: [name, nhlTeam, positions] } }.
import { TEAM_ID, writeJSON } from '../lib/config.js';
import { getPlayerIds, rosterBundle } from '../lib/fantrax.js';
import { nhl, findNhlId, isRegularSeasonId } from '../lib/nhl.js';
import { gameLogFP } from '../lib/scoring.js';
import { fxSplit, fxDisplay } from '../lib/names.js';

const N = 5;
const ids = await getPlayerIds();
const ro = await rosterBundle();
const items = new Map();
for (const x of [ro.cur, ro.next]) for (const i of x?.rosters[TEAM_ID]?.rosterItems || []) {
  const p = ids[i.id] || {}; const [first, last] = fxSplit(p.name);
  if (!items.has(i.id)) items.set(i.id, { id: i.id, first, last, name: p.name ? fxDisplay(p.name) : i.id, team: p.team, goalie: (p.position || '').includes('G') });
}

const box = new Map();
async function hitsBlocks(gameId, pid) {
  if (!box.has(gameId)) box.set(gameId, nhl(`gamecenter/${gameId}/boxscore`).catch(() => null));
  const b = await box.get(gameId); if (!b) return null;
  for (const side of ['awayTeam', 'homeTeam']) for (const g of ['forwards', 'defense']) for (const s of b.playerByGameStats?.[side]?.[g] || [])
    if (s.playerId === pid) return { hit: s.hits || 0, blk: s.blockedShots || 0 };
  return null;
}

const out = { at: new Date().toISOString(), window: N, scoring: 'league', players: {},
  // every player on the roster with name, NHL club holding his rights, and positions, so the page can name new claims
  roster: Object.fromEntries([...items.values()].map(r => [r.id, [r.name, r.team || '', (ids[r.id] || {}).position || '']])) };
for (const r of items.values()) {
  const pid = await findNhlId(r.team, r.first, r.last); if (!pid) continue;
  let log;
  try { log = (await nhl(`player/${pid}/game-log/now`)).gameLog || []; } catch (e) { continue; }
  log = log.filter(x => isRegularSeasonId(x.gameId)).slice(0, N); // regular season, newest first
  if (!log.length) continue;
  const games = [];
  for (const x of log) {
    const goalie = r.goalie || x.shotsAgainst !== undefined;
    games.push([x.gameDate, gameLogFP(x, goalie ? {} : (await hitsBlocks(x.gameId, pid) || {}))]);
  }
  out.players[r.id] = { name: r.name, nhlId: pid, gp: games.length, fpg: +(games.reduce((s, g) => s + g[1], 0) / games.length).toFixed(2), games };
}
writeJSON('data/form.json', out, 1);
console.log('form for', Object.keys(out.players).length, 'players');
