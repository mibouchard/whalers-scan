// The league pipeline shared by the daily scan (src/scan.js) and the free-agent watch (src/tools/fawatch.js):
// which leagues there are, how each is fetched (retries, per-league deadline, overall time budget), and the
// cross-league plausibility check that runs once every league is in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setLeagueSignal } from '../env.js';
import * as L from '../leagues.js';
import { retry, withDeadline, errText } from './util.js';
import { fxGroup } from './names.js';
import { recFromRow, learnCohort, makeCohort, crossCheck } from './plausible.js';

const MIN = 60000;
// [league, adapter factory, per-league deadline]. The deadline covers all three tries.
export function leagueJobs(WS) {
  const alts = lg => async () => pickName(WS, await L[lg.toLowerCase()](), lg);
  return [
    ...['AHL', 'ECHL', 'OHL', 'WHL', 'QMJHL', 'USHL'].map(lg => [lg, () => WS.hockeytech(lg)(), 4 * MIN]),
    ['Liiga', () => WS.liiga()(), 4 * MIN],
    ['KHL', () => L.khl(WS), 9 * MIN],
    ['VHL', alts('VHL'), 3 * MIN],
    ['MHL', alts('MHL'), 3 * MIN],
    ['SHL', () => L.shl(), 3 * MIN],
    ['Allsvenskan', () => L.swe('Allsvenskan'), 3 * MIN],
    ['J20', () => L.swe('J20'), 3 * MIN],
    ['NCAA', () => L.ncaa(WS.ls), 5 * MIN],
    ['Czech', () => L.czech(), 3 * MIN],
    ['NHL', () => WS.nhl()(), 4 * MIN],
  ];
}
export const LEAGUES = ['AHL', 'ECHL', 'OHL', 'WHL', 'QMJHL', 'USHL', 'Liiga', 'KHL', 'VHL', 'MHL', 'SHL', 'Allsvenskan', 'J20', 'NCAA', 'Czech', 'NHL'];

// Russian rows carry spelling variants (Aleksandr / Alexander): keep the first one Fantrax knows
async function pickName(WS, rows, lg) {
  const fx = await WS.fantrax();
  for (const r of rows) {
    if (!r.alts) continue;
    for (const [f, l] of r.alts) if (WS.candidates(fx, f, l, r.pos, lg).length) { r.first = f; r.last = l; break; }
    delete r.alts;
  }
  return rows;
}

// Fetch the chosen leagues one after another. Every league gets three tries inside its own deadline, and the whole run
// has a time budget so one slow site cannot eat the job's timeout: leagues that do not fit are reported as failed.
//   opts: { only: [names], fx, budgetMs, log, hadRows(lg) -> has this league returned rows this season? }
// Returns { collected: { lg: { rows, meta } }, failed: { lg: reason }, empty: [leagues with no games yet] }
export async function collectLeagues(WS, opts = {}) {
  const log = opts.log || (() => { }); const end = Date.now() + (opts.budgetMs ?? 22 * MIN);
  const collected = {}, failed = {}, empty = [];
  for (const [lg, fn, limit] of leagueJobs(WS)) {
    if (opts.only && opts.only.length && !opts.only.includes(lg)) continue;
    const t0 = Date.now(); const left = end - t0;
    if (left < 20000) { failed[lg] = 'skipped: the scan ran out of its time budget before this league'; log(`${lg}: FAILED ${failed[lg]}`); continue; }
    try {
      const c = await withDeadline(signal => {
        setLeagueSignal(signal);
        return retry(async () => {
          const c = await WS.collect(lg, fn, { fx: opts.fx, noTrend: true });
          // nothing at all from a league that has had rows this season is a failure, not "no games yet"
          if (!c.rows.length && opts.hadRows && opts.hadRows(lg)) throw new Error('empty: the site answered with no players, and this league has had rows this season');
          return c;
        }, 3, { signal, base: +process.env.SCAN_RETRY_MS || 3000, onRetry: (e, n) => log(`${lg}: try ${n} failed (${errText(e)}), retrying`) });
      }, Math.min(limit, left), lg);
      if (c.rows.length) collected[lg] = c; else empty.push(lg);
      log(`${lg}: ${c.rows.filter(r => !r.goalie).length} skaters, ${c.rows.filter(r => r.goalie).length} goalies, ${c.rows.filter(r => r.fx).length} matched (${((Date.now() - t0) / 1000).toFixed(0)}s)${c.meta.partial ? ' PARTIAL ' + c.meta.partial : ''}`);
    } catch (e) { failed[lg] = errText(e); log(`${lg}: FAILED ${failed[lg]}`); }
    finally { setLeagueSignal(null); }
  }
  return { collected, failed, empty };
}

// The cross-league check (src/lib/plausible.js) over freshly collected rows, plus any records parsed from a saved
// document (extra). Marks are applied to the fresh rows here; the caller applies them to the saved document.
export function checkRows(WS, fx, collected, extra = [], opts = {}) {
  const recs = [];
  for (const [lg, c] of Object.entries(collected)) for (const r of c.rows) if (r.fx) recs.push(recFromRow(lg, r));
  const saved = WS.ls.get('ws.idcohort', { b: {} });
  const learned = learnCohort(recs, saved.b || {});
  if (opts.save !== false && recs.some(r => r.ak === 'dob')) WS.ls.set('ws.idcohort', { d: new Date().toISOString().slice(0, 10), n: Object.values(learned).reduce((s, v) => s + v.length, 0), b: Object.fromEntries(Object.keys(learned).sort().map(k => [k, [...learned[k]].sort((a, b) => a - b)])) });
  // names the engine's own guards refused when matching (forward / defence disagreement)
  const rejected = [];
  for (const [lg, c] of Object.entries(collected)) for (const r of c.rows) if (r.rej && !r.fx) rejected.push(`${lg}||${r.first} ${r.last}|${r.team}|${r.rej}`);
  const rep = crossCheck([...recs, ...extra], { cohort: makeCohort(learned), year: new Date().getUTCFullYear(), fxGroup: id => fx.byId[id] ? fxGroup(fx.byId[id][2], fx.elig[id]) : '' });
  for (const r of recs) {
    if (r.drop) WS.unmatch(r.ref, r.drop); else { if (r.amb) r.ref.mq = 'amb'; if (r.vet) r.ref.vet = true; }
  }
  rep.rejected = rejected;
  return rep;
}

// Same-day hand-off from the scan to fawatch inside one workflow job, so the leagues are not all fetched twice.
// Lives in the runner's temp folder: never committed.
const cacheFile = () => path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'whalers-scan-rows.json');
export function saveRows(doc) { try { fs.writeFileSync(cacheFile(), JSON.stringify(doc)); } catch { } }
export function loadRows(maxAgeMs = 3 * 3600e3) {
  try { const d = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); return d && d.at && Date.now() - Date.parse(d.at) < maxAgeMs ? d : null; } catch { return null; }
}
