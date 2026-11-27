// NHL EDGE (puck and player tracking) numbers for every player on an NHL roster, from api-web.nhle.com/v1/edge, keyed by
// Fantrax id so free agents, other teams' players and Fred's own can be screened from one file.
//
//   node src/tools/edge.js            every player on the 32 NHL rosters (about 800 requests, 1 to 2 minutes)
//   node src/tools/edge.js weekly     the same, but only when the newest dated copy is 7 or more days old (the morning
//                                     job runs this every day, so a missed Monday is caught the next morning)
//   node src/tools/edge.js 8478402 …  only these NHL player ids, written to data/adhoc/edge-lookup.json
// From the Actions tab: One-off tool, tool = edge, args empty (everyone) or NHL ids.
//
// Two things the API does that this tool guards against:
//   - ".../now" answers with a player's LAST season that has EDGE data, not this season (a player with no NHL game this
//     season silently returns last year's numbers), so the season is always asked for by id.
//   - a player with no tracked game this season answers 404: that is "no data" (counted in `none`), not a failure.
//
// Writes data/adhoc/edge.json and a dated copy data/adhoc/edge-<date>.json (kept 84 days: subtract an older copy from
// today's to see a player's trend):
//   { at, d, season, leagueAt, cols: { sk, g }, sk: { <key>: [...] }, g: { <key>: [...] }, none, unmatched, failed }
//   key = Fantrax id, or "nhl<id>" for a player the Fantrax pool could not be matched to (`unmatched` counts them)
//   skater: [name, nhlId, team, pos, own, gp, topSpeed, topSpeedPct, bursts20, bursts20Pct, topShot, topShotPct, miles,
//            milesPct, shots, goals, hdShots, hdShotsPct, hdGoals, ozPct, ozPctile, ozEvPct, ozEvPctile]
//   goalie: [name, nhlId, team, own, gp, gaa, gaaPct, above900, above900Pct, svPct, svPctile, hdSvPct, hdSvPctile, hdSaves, hdGA]
//   own = the Fantrax team's short code, FA or WW, as data/league.json had it at `leagueAt` ('' = not in that file). It is
//         a convenience for screening: check the live Fantrax status before acting on it.
//   Speeds in mph, distance in miles (season total), percentiles 0-100 within the player's position group (the NHL's own),
//   "hd" = the NHL's high-danger shot location, shots and goals = all tracked shots on goal, oz = share of his ice time
//   spent in the offensive zone (all situations / even strength).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, NHL_TEAMS, cliArgs, readJSON, writeJSON, torontoDate } from '../lib/config.js';
import { getPlayerIds } from '../lib/fantrax.js';
import { clubRoster, seasonId } from '../lib/nhl.js';
import { makeMatcher } from '../lib/names.js';
import { careersNid, boxNid } from '../lib/fostats.js';
import { retry } from '../lib/util.js';

const W = 'https://api-web.nhle.com/v1/edge/';
const KEEP_DAYS = 84, WEEK = 7;
const n = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? +v.toFixed(d) : null);
const pc = v => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) : null);
const loc = (list, code) => (list || []).find(x => x.locationCode === code) || {};

export const COLS = {
  sk: ['name', 'nhlId', 'team', 'pos', 'own', 'gp', 'topSpeed', 'topSpeedPct', 'bursts20', 'bursts20Pct', 'topShot', 'topShotPct', 'miles', 'milesPct', 'shots', 'goals', 'hdShots', 'hdShotsPct', 'hdGoals', 'ozPct', 'ozPctile', 'ozEvPct', 'ozEvPctile'],
  g: ['name', 'nhlId', 'team', 'own', 'gp', 'gaa', 'gaaPct', 'above900', 'above900Pct', 'svPct', 'svPctile', 'hdSvPct', 'hdSvPctile', 'hdSaves', 'hdGA'],
};
export function skaterRow(name, own, d) {
  const p = d.player || {}, sp = d.skatingSpeed || {}, all = loc(d.sogSummary, 'all'), hd = loc(d.sogSummary, 'high'), z = d.zoneTimeDetails || {};
  return [name, p.id, p.team?.abbrev || '', p.position || '', own, p.gamesPlayed ?? null,
    n(sp.speedMax?.imperial), pc(sp.speedMax?.percentile), sp.burstsOver20?.value ?? null, pc(sp.burstsOver20?.percentile),
    n(d.topShotSpeed?.imperial), pc(d.topShotSpeed?.percentile), n(d.totalDistanceSkated?.imperial, 1), pc(d.totalDistanceSkated?.percentile),
    all.shots ?? null, all.goals ?? null, hd.shots ?? null, pc(hd.shotsPercentile), hd.goals ?? null,
    n(z.offensiveZonePctg * 100, 1), pc(z.offensiveZonePercentile), n(z.offensiveZoneEvPctg * 100, 1), pc(z.offensiveZoneEvPercentile)];
}
export function goalieRow(name, own, d) {
  const p = d.player || {}, s = d.stats || {}, all = loc(d.shotLocationSummary, 'all'), hd = loc(d.shotLocationSummary, 'high');
  return [name, p.id, p.team?.abbrev || '', own, p.gamesPlayed ?? null,
    n(s.goalsAgainstAvg?.value), pc(s.goalsAgainstAvg?.percentile), n(s.gamesAbove900?.value, 3), pc(s.gamesAbove900?.percentile),
    n(all.savePctg, 3), pc(all.savePctgPercentile), n(hd.savePctg, 3), pc(hd.savePctgPercentile), hd.saves ?? null, hd.goalsAgainst ?? null];
}
// the season asked for must be the season answered (the player block carries no season, the list of seasons does)
export const hasSeason = (d, season) => (d?.seasonsWithEdgeStats || []).some(s => String(s.id) === String(season) && (s.gameTypes || []).includes(2));
// "weekly": is the newest dated copy (file names edge-YYYY-MM-DD.json) less than a week older than `today`?
export function freshEnough(files, today, days = WEEK) {
  const last = files.map(f => /^edge-(\d{4}-\d{2}-\d{2})\.json$/.exec(f)?.[1]).filter(Boolean).sort().pop();
  return !!last && (Date.parse(today) - Date.parse(last)) / 864e5 < days;
}

// 404 = no EDGE data for that player and season: answer null at once instead of retrying
const edge = p => retry(async () => {
  const r = await fetch(W + p); if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${r.status} edge/${p}`);
  return r.json();
}, 3);
// run fn over items, `width` at a time
async function pool(items, width, fn) { let i = 0; await Promise.all(Array.from({ length: width }, async () => { while (i < items.length) await fn(items[i++]); })); }

async function main() {
  const args = cliArgs(); const season = seasonId(); const today = torontoDate();
  const dir = path.join(ROOT, 'data', 'adhoc');
  const asked = args.join(' ').split(/[\s,]+/).filter(x => /^\d{7}$/.test(x));
  if (args.includes('weekly') && freshEnough(fs.existsSync(dir) ? fs.readdirSync(dir) : [], today)) { console.log('edge: this week\'s copy exists, nothing to do'); return; }

  // who to read: [{ pid, first, last, team, pos }]
  const todo = [];
  if (asked.length) for (const id of asked) todo.push({ pid: +id });
  else {
    const seen = new Set();
    for (const team of NHL_TEAMS) for (const [pid, p] of Object.entries(await clubRoster(team))) if (!seen.has(pid)) { seen.add(pid); todo.push({ pid: +pid, team, ...p }); }
    if (todo.length < 500) throw new Error(`only ${todo.length} players on the NHL rosters: not saved`);
  }

  // NHL id -> Fantrax id (careers files, box files, then the strict name matcher), and who owns him
  const nid2fx = {}; for (const [fx, nid] of Object.entries({ ...careersNid(), ...boxNid() })) nid2fx[nid] = fx;
  const M = makeMatcher(await getPlayerIds());
  const lg = readJSON('data/league.json') || {}; const owner = {};
  for (const t of Object.values(lg.teams || {})) for (const r of [...(t.cur || []), ...(t.next || [])]) owner[r[0]] = t.short;
  const ownOf = fx => owner[fx] || lg.free?.[fx] || '';

  const out = { at: new Date().toISOString(), d: today, season, leagueAt: lg.at || null, cols: COLS, sk: {}, g: {}, none: 0, unmatched: 0, failed: 0 };
  const errors = [];
  await pool(todo, 6, async t => {
    try {
      // an id given by hand may be either: try the skater report first, then the goalie one
      let d = null, goalie = t.pos ? t.pos === 'G' : null;
      if (goalie !== true) { d = await edge(`skater-detail/${t.pid}/${season}/2`); if (d) goalie = false; }
      if (!d && goalie !== false) { d = await edge(`goalie-detail/${t.pid}/${season}/2`); if (d) goalie = true; }
      if (!d || !hasSeason(d, season)) { out.none++; return; }
      const p = d.player || {}; const first = t.first || p.firstName?.default || '', last = t.last || p.lastName?.default || '';
      const team = p.team?.abbrev || t.team || '';
      const fx = nid2fx[t.pid] || M.find({ first, last, team, pos: goalie ? 'G' : (p.position || t.pos), goalie }, { strict: true })?.id || null;
      if (!fx) out.unmatched++;
      const key = fx || 'nhl' + t.pid, name = `${first} ${last}`.trim(), own = fx ? ownOf(fx) : '';
      if (goalie) out.g[key] = goalieRow(name, own, d); else out.sk[key] = skaterRow(name, own, d);
    } catch (e) { out.failed++; if (errors.length < 5) errors.push(String(e?.message || e)); }
  });

  const got = Object.keys(out.sk).length + Object.keys(out.g).length;
  console.log(`edge ${season}: ${Object.keys(out.sk).length} skaters, ${Object.keys(out.g).length} goalies, ${out.none} without data, ${out.unmatched} not matched to Fantrax, ${out.failed} failed, ${JSON.stringify(out).length} bytes`);
  if (asked.length) { writeJSON('data/adhoc/edge-lookup.json', out, 1); if (out.failed === todo.length) throw new Error('every EDGE request failed: ' + errors[0]); return; }
  // a part of the league is never saved as if it were the whole of it: yesterday's file stays and the step fails
  if (out.failed > todo.length * 0.05) throw new Error(`${out.failed} of ${todo.length} EDGE requests failed (${errors[0]}): not saved`);
  const before = readJSON('data/adhoc/edge.json'); const was = before?.season === season ? Object.keys(before.sk || {}).length + Object.keys(before.g || {}).length : 0;
  if (was >= 200 && got < was * 0.8) throw new Error(`EDGE rows shrank from ${was} to ${got}: not saved`);
  writeJSON('data/adhoc/edge.json', out); writeJSON(`data/adhoc/edge-${today}.json`, out);
  for (const f of fs.readdirSync(dir)) { const m = f.match(/^edge-(\d{4}-\d{2}-\d{2})\.json$/); if (m && Date.now() - Date.parse(m[1]) > KEEP_DAYS * 864e5) fs.unlinkSync(path.join(dir, f)); }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) await main();
