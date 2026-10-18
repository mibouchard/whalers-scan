// This season's NHL numbers for the Front Office player card, rebuilt every morning after the box scores (step "stats").
//
// data/fo/season.json  every NHL player's regular-season totals so far, from the NHL's season reports
//   { at, season, cols: { sk: [...], g: [...] }, sk: { <fantraxId>: [...] }, g: { <fantraxId>: [...] }, unmatched }
//   skater: [gp, g, a, pm, pim, sog, ppp, shg, gwg, hit, blk, toi]   (toi = seconds per game)
//   goalie: [gp, gs, w, l, otl, ga, sa, so, toi]                       (toi = seconds, total)
// data/fo/games.json   each player's last games (newest first) from the dated box files (data/adhoc/box-*.json, 14 days)
//   { at, d, n, cols: { sk: [...], g: [...] }, p: { <fantraxId>: [[...], ...] } }
//   skater: [date, opp, ha, res, fp, g, a, pm, pim, sog, ppp, shg, gwg, hit, blk, toi]
//   goalie: [date, opp, ha, res, fp, dec, sv, sa, ga, so, toi]
//   ha is "@" (away) or "vs" (home); res is "W 4-1", "L 2-3 OT" and so on, from his club's side.
// Both are keyed by Fantrax id: NHL id -> Fantrax id from the careers files, the box files, then the name matcher.
// The board caps a document at 256 KB: games.json keeps 5 games a player, fewer if it would pass 230,000 bytes.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON, writeJSON } from '../lib/config.js';
import { getPlayerIds } from '../lib/fantrax.js';
import { seasonId } from '../lib/nhl.js';
import { makeMatcher } from '../lib/names.js';
import { careersNid, boxNid, report, byPlayer } from '../lib/fostats.js';

const LIMIT = 230000;
const season = seasonId();

// ---- recent games from the box files ----
const dir = path.join(ROOT, 'data', 'adhoc');
const files = fs.readdirSync(dir).filter(f => /^box-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const games = {}; let lastDay = null;
for (const f of files) {
  const b = readJSON('data/adhoc/' + f); if (!b?.rows) continue; lastDay = b.d;
  // "PIT 2-5 COL" or "PIT 2-5 COL OT": away first
  const score = {};
  for (const lab of b.games || []) {
    const m = /^([A-Z]{3}) (\d+)-(\d+) ([A-Z]{3})(?: (\w+))?$/.exec(lab); if (!m) continue;
    const [, aw, as, hs, hm, end] = m; const x = end ? ' ' + end : '';
    score[aw] = { opp: hm, ha: '@', res: `${+as > +hs ? 'W' : 'L'} ${as}-${hs}${x}` };
    score[hm] = { opp: aw, ha: 'vs', res: `${+hs > +as ? 'W' : 'L'} ${hs}-${as}${x}` };
  }
  for (const r of b.rows) {
    if (!r.fx) continue;
    const s = score[r.team] || { opp: r.opp, ha: '', res: '' };
    const row = r.pos === 'G'
      ? [b.d, r.opp, s.ha, s.res, r.fp, r.dec || '', r.sv, r.sa, r.ga, r.so, r.toi]
      : [b.d, r.opp, s.ha, s.res, r.fp, r.g, r.a, r.pm, r.pim, r.sog, r.ppp, r.shg, r.gwg, r.hit, r.blk, r.toi];
    (games[r.fx] ||= []).push(row);
  }
}
let n = 5, gamesOut;
for (; n >= 2; n--) {
  const p = {}; for (const [fx, list] of Object.entries(games)) p[fx] = list.slice(-n).reverse();
  gamesOut = { at: new Date().toISOString(), d: lastDay, n, cols: { sk: ['date', 'opp', 'ha', 'res', 'fp', 'g', 'a', 'pm', 'pim', 'sog', 'ppp', 'shg', 'gwg', 'hit', 'blk', 'toi'], g: ['date', 'opp', 'ha', 'res', 'fp', 'dec', 'sv', 'sa', 'ga', 'so', 'toi'] }, p };
  if (JSON.stringify(gamesOut).length <= LIMIT) break;
}
writeJSON('data/fo/games.json', gamesOut);

// ---- season totals from the NHL's season reports ----
const [sum, rt, gl] = await Promise.all([report('skater/summary', season), report('skater/realtime', season), report('goalie/summary', season)]);
const nid2fx = {};
for (const [fx, nid] of Object.entries({ ...careersNid(), ...boxNid() })) nid2fx[nid] = fx;
const ids = await getPlayerIds(); const M = makeMatcher(ids);
const fxOf = (r, full, isG) => {
  if (nid2fx[r.playerId]) return nid2fx[r.playerId];
  const last = r.lastName || full.split(' ').slice(-1)[0], first = full.slice(0, full.length - last.length).trim();
  const m = M.find({ first, last, team: String(r.teamAbbrevs || '').split(',').pop(), pos: isG ? 'G' : r.positionCode, goalie: isG }, { strict: true });
  return m ? m.id : null;
};
const S = byPlayer(sum, r => ({ gp: r.gamesPlayed || 0, g: r.goals || 0, a: r.assists || 0, pm: r.plusMinus || 0, pim: r.penaltyMinutes || 0, sog: r.shots || 0, ppp: r.ppPoints || 0, shg: r.shGoals || 0, gwg: r.gameWinningGoals || 0, toiT: (r.timeOnIcePerGame || 0) * (r.gamesPlayed || 0), _r: r }));
const H = byPlayer(rt, r => ({ hit: r.hits || 0, blk: r.blockedShots || 0 }));
const G = byPlayer(gl, r => ({ gp: r.gamesPlayed || 0, gs: r.gamesStarted || 0, w: r.wins || 0, l: r.losses || 0, otl: r.otLosses || 0, ga: r.goalsAgainst || 0, sa: r.shotsAgainst || 0, so: r.shutouts || 0, toi: r.timeOnIce || 0, _r: r }));
const out = { at: new Date().toISOString(), season: `${season.slice(0, 4)}-${season.slice(6)}`, cols: { sk: ['gp', 'g', 'a', 'pm', 'pim', 'sog', 'ppp', 'shg', 'gwg', 'hit', 'blk', 'toi'], g: ['gp', 'gs', 'w', 'l', 'otl', 'ga', 'sa', 'so', 'toi'] }, sk: {}, g: {}, unmatched: 0 };
for (const [nid, x] of Object.entries(S)) {
  const fx = fxOf(x._r, x._r.skaterFullName || '', false); if (!fx) { out.unmatched++; continue; }
  const h = H[nid] || {};
  out.sk[fx] = [x.gp, x.g, x.a, x.pm, x.pim, x.sog, x.ppp, x.shg, x.gwg, h.hit ?? null, h.blk ?? null, x.gp ? Math.round(x.toiT / x.gp) : 0];
}
for (const [, x] of Object.entries(G)) {
  const fx = fxOf(x._r, x._r.goalieFullName || '', true); if (!fx) { out.unmatched++; continue; }
  out.g[fx] = [x.gp, x.gs, x.w, x.l, x.otl, x.ga, x.sa, x.so, Math.round(x.toi)];
}
writeJSON('data/fo/season.json', out);
console.log(`games: ${Object.keys(games).length} players, ${n} games each, ${JSON.stringify(gamesOut).length} bytes, through ${lastDay} | season ${out.season}: ${Object.keys(out.sk).length} skaters, ${Object.keys(out.g).length} goalies, ${out.unmatched} not matched to Fantrax, ${JSON.stringify(out).length} bytes`);
if (JSON.stringify(out).length > LIMIT) throw new Error('season.json is too big for the board');
