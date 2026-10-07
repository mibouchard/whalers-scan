// End of the daily job: one small file that says whether everything ran.
//   node src/ci/health.js           writes data/health.json
//   node src/ci/health.js --check   exits 1 if any league or step failed (run after the results are pushed, so a red job,
//                                   and GitHub's failure email, never costs the data)
// data/health.json: { at, d, mode, steps: { scan, form, pool, league, box, alertLate, fawatch, week: "ok" | "ERR: ..." },
//                     leagues: <status map from status.json>, errors: { <league or "Fantrax">: reason }, fantrax, stale,
//                     alert: { date, at } }   (alert = last night's data/adhoc/alert.json, so a reader can tell whether the
//                                              11:40 PM alert job ran)
import fs from 'node:fs';
import path from 'node:path';
import { torontoDate, readJSON, writeJSON } from '../lib/config.js';
import { healthDirOf } from './paths.js';

const STEPS = ['scan', 'form', 'pool', 'league', 'box', 'alertLate', 'fawatch', 'week'];
const today = torontoDate();
if (process.argv.includes('--check')) {
  const h = readJSON('data/health.json');
  if (!h || h.d !== today) { console.error('health: no data/health.json for today'); process.exit(1); }
  const badSteps = Object.entries(h.steps || {}).filter(([, v]) => String(v).startsWith('ERR'));
  const badLeagues = Object.entries(h.errors || {});
  for (const [k, v] of badSteps) console.error(`::error::step ${k}: ${v}`);
  for (const [k, v] of badLeagues) console.error(`::error::${k}: ${h.leagues?.[k] ? '[' + h.leagues[k] + '] ' : ''}${v}`);
  if (badSteps.length || badLeagues.length) { console.error(`health: ${badSteps.length} step(s) and ${badLeagues.length} league(s) failed (results were saved)`); process.exit(1); }
  console.log('health: all steps and leagues ok'); process.exit(0);
}

const prev = readJSON('data/health.json'); const keep = prev && prev.d === today && process.env.RUN_MODE === 'retry' ? prev.steps || {} : {};
const dir = healthDirOf(); const steps = {};
for (const s of STEPS) {
  let v = null; try { v = fs.readFileSync(path.join(dir, s + '.txt'), 'utf8').trim(); } catch { }
  steps[s] = v || keep[s] || 'ERR: did not run';
}
const st = readJSON('data/status.json'); const errors = { ...(st?.errors || {}) };
const scanToday = st && st.at && torontoDate(new Date(st.at)) === today && !(st.subset || []).length;
if (!scanToday) errors.scan = st ? `data/status.json is from ${st.d}, not today` : 'no data/status.json';
const alert = readJSON('data/adhoc/alert.json');
const out = { at: new Date().toISOString(), d: today, mode: process.env.RUN_MODE || 'full', steps, leagues: st?.status || {}, errors, fantrax: st?.fantrax || null, stale: st?.stale || {}, alert: alert ? { date: alert.date ?? null, at: alert.at ?? null } : null };
writeJSON('data/health.json', out, 1);
console.log('health:', Object.entries(steps).map(([k, v]) => `${k}=${v === 'ok' ? 'ok' : 'ERR'}`).join(' '), '| league errors:', Object.keys(errors).join(' ') || 'none');
