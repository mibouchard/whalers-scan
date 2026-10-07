// NHL API helpers (api-web.nhle.com) shared by box.js, nightalert.js, form.js and week.js: one place that turns a
// finished game into per-player fantasy lines, so every tool scores shutouts, game-winners and goalie points the same way.
import '../env.js';
import { getJSONr } from './util.js';
import { skaterFP, goalieFP } from './scoring.js';
import { nameKey, fold } from './names.js';

const W = 'https://api-web.nhle.com/v1/';
export const nhl = p => getJSONr(W + p);
export const isFinal = g => ['FINAL', 'OFF'].includes(g.gameState);
export const gameLabel = g => `${g.awayTeam.abbrev}@${g.homeTeam.abbrev}`;
export const sec = t => { if (!t) return 0; const [m, s] = String(t).split(':').map(Number); return (m || 0) * 60 + (s || 0); };
export const mmss = s => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
export const isRegularSeasonId = id => String(id).slice(4, 6) === '02';
export const seasonId = (d = new Date()) => { const y = d.getUTCMonth() >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; return `${y}${y + 1}`; };

// Regular-season games on a date (YYYY-MM-DD): { all, final, pending }
export async function gamesOn(date) {
  const s = await nhl(`score/${date}`); const all = (s.games || []).filter(g => g.gameType === 2);
  return { all, final: all.filter(isFinal), pending: all.filter(g => !isFinal(g)) };
}

// Goals of a game that are not shootout goals -> per-player power-play points, short-handed goals and the game-winner,
// plus each team's goal count. The game-winning goal is the winner's (loser's final score + 1)th goal; a game decided in
// a shootout has none.
export function goalExtras(box, landing) {
  const away = box.awayTeam.abbrev, home = box.homeTeam.abbrev;
  const fin = { [away]: box.awayTeam.score, [home]: box.homeTeam.score };
  const winner = fin[away] > fin[home] ? away : home, loser = winner === away ? home : away;
  const ppp = {}, shg = {}, gwg = {}, goals = { [away]: 0, [home]: 0 }; const seen = Array.isArray(landing?.summary?.scoring);
  for (const per of landing?.summary?.scoring || []) {
    if (per.periodDescriptor?.periodType === 'SO') continue;
    for (const gl of per.goals || []) {
      const team = gl.teamAbbrev?.default || gl.teamAbbrev; goals[team] = (goals[team] || 0) + 1;
      const st = String(gl.strength || '').toLowerCase();
      if (st === 'pp') { ppp[gl.playerId] = (ppp[gl.playerId] || 0) + 1; for (const a of gl.assists || []) ppp[a.playerId] = (ppp[a.playerId] || 0) + 1; }
      if (st === 'sh') shg[gl.playerId] = (shg[gl.playerId] || 0) + 1;
      if (team === winner && goals[team] === fin[loser] + 1) gwg[gl.playerId] = 1;
    }
  }
  // no scoring summary (rare): fall back to the final score, less the one goal a shootout adds to the winner
  if (!seen) { const so = (landing?.gameOutcome || box.gameOutcome)?.lastPeriodType === 'SO'; goals[away] = fin[away]; goals[home] = fin[home]; if (so) goals[winner]--; }
  return { ppp, shg, gwg, goals, winner, loser };
}

// One finished game -> a row per player who played:
//   skater { pid, name, team, opp, pos, fp, toi, g, a, ppp, shg, gwg, pm, sog, hit, blk, pim }
//   goalie { pid, name, team, opp, pos: 'G', goalie: true, starter, fp, toi, dec, sv, sa, ga, so, g, a }
// Goalies: W 5 only with the win (a shootout or overtime loss is no win); SO 5 only when he played the whole game for
// his team and the other team scored no goal at all (shootout goals do not count); his own goals and assists score
// like a skater's.
export function rowsFromGame(box, landing) {
  const x = goalExtras(box, landing); const rows = [];
  for (const side of ['awayTeam', 'homeTeam']) {
    const team = box[side].abbrev, opp = side === 'awayTeam' ? box.homeTeam.abbrev : box.awayTeam.abbrev;
    const S = box.playerByGameStats?.[side] || {};
    for (const p of [...(S.forwards || []), ...(S.defense || [])]) {
      const l = { g: p.goals || 0, a: p.assists || 0, ppp: x.ppp[p.playerId] || 0, shg: x.shg[p.playerId] || 0, gwg: x.gwg[p.playerId] || 0, pm: p.plusMinus || 0, sog: p.sog || 0, hit: p.hits || 0, blk: p.blockedShots || 0, pim: p.pim || 0 };
      rows.push({ pid: p.playerId, name: p.name?.default || '', team, opp, pos: p.position, fp: skaterFP(l), toi: p.toi || '', ...l });
    }
    const played = (S.goalies || []).filter(p => p.toi && p.toi !== '00:00');
    for (const p of played) {
      const [sv0, sa0] = String(p.saveShotsAgainst || '').split('/').map(Number);
      const ga = p.goalsAgainst || 0, sa = p.shotsAgainst ?? (isNaN(sa0) ? null : sa0), sv = p.saves ?? (isNaN(sv0) ? (sa != null ? sa - ga : 0) : sv0);
      const w = p.decision === 'W' ? 1 : 0;
      const so = played.length === 1 && ga === 0 && (x.goals[opp] || 0) === 0 ? 1 : 0;
      const l = { dec: p.decision || '', sv, sa, ga, so, g: p.goals || 0, a: p.assists || 0 };
      rows.push({ pid: p.playerId, name: p.name?.default || '', team, opp, pos: 'G', goalie: true, starter: !!p.starter, fp: goalieFP({ w, so, sv, ga, g: l.g, a: l.a }), toi: p.toi, ...l });
    }
  }
  return rows;
}
export async function gameRows(gameId) {
  const [box, landing] = await Promise.all([nhl(`gamecenter/${gameId}/boxscore`), nhl(`gamecenter/${gameId}/landing`)]);
  return rowsFromGame(box, landing);
}

// Full names and birthdates from a club's current roster: { playerId: { first, last, dob, pos } }
const rosterCache = new Map();
export function clubRoster(team) {
  if (!rosterCache.has(team)) rosterCache.set(team, nhl(`roster/${team}/current`).then(r => {
    const m = {};
    for (const [grp, pos] of [['forwards', null], ['defensemen', 'D'], ['goalies', 'G']]) for (const p of r[grp] || []) m[p.id] = { first: p.firstName.default, last: p.lastName.default, dob: p.birthDate || null, pos: pos || p.positionCode };
    return m;
  }).catch(() => ({})));
  return rosterCache.get(team);
}
export const ageFrom = (dob, on = new Date()) => { if (!dob) return null; const b = String(dob).slice(0, 10), r = on.toISOString().slice(0, 10); let y = +r.slice(0, 4) - +b.slice(0, 4); if (r.slice(5) < b.slice(5)) y--; return y; };

// NHL player id for a Fantrax player: exact name on his club's roster, else the only player on that roster with the
// same last name and first initial (Tommy / Thomas).
export async function findNhlId(team, first, last) {
  if (!team) return null; const ro = await clubRoster(team); const want = nameKey(first, last);
  const all = Object.entries(ro); const hit = all.find(([, p]) => nameKey(p.first, p.last) === want); if (hit) return +hit[0];
  const l = fold(last).replace(/ /g, ''), ini = fold(first)[0];
  const alt = all.filter(([, p]) => fold(p.last).replace(/ /g, '') === l && fold(p.first)[0] === ini);
  return alt.length === 1 ? +alt[0][0] : null;
}
// Season hits and blocked shots per NHL player id from the NHL stats report (game logs do not carry them).
// Returns { playerId: { hit, blk, gp } }, or null when the report cannot be read.
export async function seasonHitsBlocks(season = seasonId()) {
  try {
    const j = await getJSONr(`https://api.nhle.com/stats/rest/en/skater/realtime?limit=-1&cayenneExp=${encodeURIComponent(`seasonId=${season} and gameTypeId=2`)}`);
    if (!Array.isArray(j.data) || !j.data.length || j.data[0].hits === undefined || j.data[0].blockedShots === undefined) return null;
    const m = {}; for (const s of j.data) { const o = m[s.playerId] ||= { hit: 0, blk: 0, gp: 0 }; o.hit += s.hits || 0; o.blk += s.blockedShots || 0; o.gp += s.gamesPlayed || 0; }
    return m;
  } catch { return null; }
}
