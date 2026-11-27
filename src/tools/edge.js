// NHL EDGE (puck and player tracking) numbers for every NHL player on the HFD Fantrax roster (current and next period),
// from api-web.nhle.com/v1/edge. Run by hand: Actions -> One-off tool -> tool = edge. ARGS (optional): NHL player ids
// separated by spaces or commas, to read those players instead of the roster (keyed "nhl<id>" in the file).
//
// Two things the API does that this tool guards against:
//   - ".../now" answers with a player's LAST season that has EDGE data, not this season (a player with no NHL game this
//     season silently returns last year's numbers), so the season is always asked for by id.
//   - a player with no tracked game this season answers 404: that is "no data" (listed in `none`), not a failure.
//
// Writes data/adhoc/edge.json: { at, season, cols: { sk, g }, sk: { <fantraxId>: [...] }, g: { <fantraxId>: [...] },
//                                none: [[fantraxId, name, why], ...] }
//   skater: [name, nhlId, team, pos, gp, topSpeed, topSpeedPct, bursts20, bursts20Pct, topShot, topShotPct, miles, milesPct,
//            hdShots, hdShotsPct, hdGoals, ozPct, ozPctile, ozEvPct, ozEvPctile]
//   goalie: [name, nhlId, team, gp, gaa, gaaPct, above900, above900Pct, svPct, svPctile, hdSvPct, hdSvPctile, hdSaves, hdGA]
//   Speeds in mph, distance in miles (season total), percentiles 0-100 within the player's position group (the NHL's own),
//   "hd" = the NHL's high-danger shot location, oz = share of his ice time spent in the offensive zone (all / even strength).
import { TEAM_ID, writeJSON } from '../lib/config.js';
import { getPlayerIds, rosterBundle } from '../lib/fantrax.js';
import { findNhlId, seasonId } from '../lib/nhl.js';
import { fxSplit, fxDisplay } from '../lib/names.js';
import { retry } from '../lib/util.js';

const W = 'https://api-web.nhle.com/v1/edge/';
const season = seasonId();
// 404 = no EDGE data for that player and season: answer null at once instead of retrying
const edge = p => retry(async () => {
  const r = await fetch(W + p); if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${r.status} edge/${p}`);
  return r.json();
}, 3);
const n = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? +v.toFixed(d) : null);
const pc = v => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) : null);
const loc = (list, code) => (list || []).find(x => x.locationCode === code) || {};

export function skaterRow(name, d) {
  const p = d.player || {}, sp = d.skatingSpeed || {}, hd = loc(d.sogSummary, 'high'), z = d.zoneTimeDetails || {};
  return [name, p.id, p.team?.abbrev || '', p.position || '', p.gamesPlayed ?? null,
    n(sp.speedMax?.imperial), pc(sp.speedMax?.percentile), sp.burstsOver20?.value ?? null, pc(sp.burstsOver20?.percentile),
    n(d.topShotSpeed?.imperial), pc(d.topShotSpeed?.percentile), n(d.totalDistanceSkated?.imperial, 1), pc(d.totalDistanceSkated?.percentile),
    hd.shots ?? null, pc(hd.shotsPercentile), hd.goals ?? null,
    n(z.offensiveZonePctg * 100, 1), pc(z.offensiveZonePercentile), n(z.offensiveZoneEvPctg * 100, 1), pc(z.offensiveZoneEvPercentile)];
}
export function goalieRow(name, d) {
  const p = d.player || {}, s = d.stats || {}, all = loc(d.shotLocationSummary, 'all'), hd = loc(d.shotLocationSummary, 'high');
  return [name, p.id, p.team?.abbrev || '', p.gamesPlayed ?? null,
    n(s.goalsAgainstAvg?.value), pc(s.goalsAgainstAvg?.percentile), n(s.gamesAbove900?.value, 3), pc(s.gamesAbove900?.percentile),
    n(all.savePctg, 3), pc(all.savePctgPercentile), n(hd.savePctg, 3), pc(hd.savePctgPercentile), hd.saves ?? null, hd.goalsAgainst ?? null];
}
export const COLS = {
  sk: ['name', 'nhlId', 'team', 'pos', 'gp', 'topSpeed', 'topSpeedPct', 'bursts20', 'bursts20Pct', 'topShot', 'topShotPct', 'miles', 'milesPct', 'hdShots', 'hdShotsPct', 'hdGoals', 'ozPct', 'ozPctile', 'ozEvPct', 'ozEvPctile'],
  g: ['name', 'nhlId', 'team', 'gp', 'gaa', 'gaaPct', 'above900', 'above900Pct', 'svPct', 'svPctile', 'hdSvPct', 'hdSvPctile', 'hdSaves', 'hdGA'],
};

// the season asked for must be the season answered (the player block carries no season, the list of seasons does)
const hasSeason = d => (d?.seasonsWithEdgeStats || []).some(s => String(s.id) === season && (s.gameTypes || []).includes(2));

async function main() {
  const out = { at: new Date().toISOString(), season, cols: COLS, sk: {}, g: {}, none: [] };
  const todo = [];
  const asked = String(process.env.ARGS || '').split(/[\s,]+/).filter(x => /^\d{7}$/.test(x));
  if (asked.length) for (const id of asked) todo.push({ key: 'nhl' + id, name: '', pid: +id, goalie: null });
  else {
    const ids = await getPlayerIds(); const ro = await rosterBundle(); const seen = new Set();
    for (const x of [ro.cur, ro.next]) for (const i of x?.rosters[TEAM_ID]?.rosterItems || []) {
      if (seen.has(i.id)) continue; seen.add(i.id);
      const p = ids[i.id] || {}; const [first, last] = fxSplit(p.name); const name = p.name ? fxDisplay(p.name) : i.id;
      const pid = await findNhlId(p.team, first, last);
      if (!pid) { out.none.push([i.id, name, 'not on an NHL roster']); continue; }
      todo.push({ key: i.id, name, pid, goalie: (p.position || '').includes('G') });
    }
  }
  let failed = 0;
  for (const t of todo) {
    try {
      // an id given by hand may be either: try the skater report first, then the goalie one
      let d = null, goalie = t.goalie;
      if (goalie !== true) { d = await edge(`skater-detail/${t.pid}/${season}/2`); if (d) goalie = false; }
      if (!d && goalie !== false) { d = await edge(`goalie-detail/${t.pid}/${season}/2`); if (d) goalie = true; }
      if (!d || !hasSeason(d)) { out.none.push([t.key, t.name, 'no EDGE data this season']); continue; }
      const name = t.name || `${d.player?.firstName?.default || ''} ${d.player?.lastName?.default || ''}`.trim();
      if (goalie) out.g[t.key] = goalieRow(name, d); else out.sk[t.key] = skaterRow(name, d);
    } catch (e) { failed++; out.none.push([t.key, t.name, 'ERR ' + String(e?.message || e)]); }
  }
  writeJSON('data/adhoc/edge.json', out, 1);
  console.log('edge:', Object.keys(out.sk).length, 'skaters,', Object.keys(out.g).length, 'goalies,', out.none.length, 'without data,', failed, 'failed');
  // every request failing is a broken feed, not a quiet night: fail the step so the job goes red
  if (todo.length && failed === todo.length) { console.error('edge: every request failed'); process.exit(1); }
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
