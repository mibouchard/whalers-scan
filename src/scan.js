// Daily minors scan, headless. Runs every league, matches players to Fantrax (ownership from next scoring period, so this
// week's claims count), scores them with the shared engine, and writes:
//   data/latest.json       the same document shape as the Front Office "minors/latest" doc
//   data/YYYY-MM-DD.json   that day's snapshot
//   data/status.json       per-league outcome of the last run (ok / error / no games), for the morning report
// A league that fails is reported and skipped; the rest still run.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadEngine } from './env.js';
import * as L from './leagues.js';

const WS = loadEngine();
Object.assign(WS.NHLE, { ECHL: .15, SHL: .566, Allsvenskan: .297, J20: .09, NCAA: .194, VHL: .30, MHL: .12, Czech: .418 });
if (!WS.HT.ECHL) WS.HT.ECHL = ['echl', '2c2b89ea7345cae8'];

const today = new Date().toISOString().slice(0, 10);
const res = { d: today, at: new Date().toISOString(), src: 'github-actions',
  cols: { sk: ['lg', 'fx', 'own', 'st', 'name', 'team', 'pos', 'age', 'gp', 'g', 'a', 'pts', 'ppp', 'ppg', 'nhle', 'prev', 'yoy', 'tr', 'rgp', 'toi'], g: ['lg', 'fx', 'own', 'st', 'name', 'team', 'age', 'gp', 'svp', 'gaa', 'w', 'min'] },
  cov: {}, status: {}, owned: [], avail: [], und: [], risers: [], goalies: [],
  pending: ['Swiss NL', 'DEL', 'Mestis / Finnish U20', 'Slovak Extraliga', 'BCHL'],
  notes: {
    NHL: 'Only players who have played NHL games are listed.',
    Names: "Names match across spellings (Dmitry/Dmitri, O'Reilly/OReilly).",
    Russia: 'VHL and MHL names are transliterated from Russian and matched to Fantrax by name only (no birthdates), so common names can collide: verify before acting on a VHL/MHL match.',
    Ages: 'Allsvenskan, VHL and MHL rows have no ages; NCAA ages are estimated from class year; Czech ages are bands (19 = U20, 22 = U24, 25 = 24+).',
    Claims: 'Ownership comes from the next scoring period, so claims made this week already count.',
  } };

const add = (lg, r) => {
  res.cov[lg] = [r.nSk, r.nG, r.matched, r.owned.length, r.nDays];
  r.owned.forEach(x => res.owned.push(lg + '|' + x)); r.avail.slice(0, 8).forEach(x => res.avail.push(lg + '|' + x));
  r.undrafted.slice(0, 4).forEach(x => res.und.push(lg + '|' + x)); r.risers.forEach(x => res.risers.push(lg + '|' + x)); r.goalies.forEach(x => res.goalies.push(lg + '|' + x));
};

// Russian rows carry spelling variants: keep the one Fantrax uses
let fx0 = null;
const pickName = async rows => { fx0 = fx0 || await WS.fantrax(); for (const r of rows) { if (!r.alts) continue; for (const [f, l] of r.alts) { const c = fx0.pool[WS.key(f, l)]; if (c && c.some(x => /G/.test(x[2]) === !!r.goalie)) { r.first = f; r.last = l; break; } } delete r.alts; } return rows; };

const jobs = [
  ...['AHL', 'ECHL', 'OHL', 'WHL', 'QMJHL', 'USHL'].map(lg => [lg, () => WS.hockeytech(lg)(), {}]),
  ['Liiga', () => WS.liiga()(), {}],
  ['KHL', () => L.khl(WS), { maxAge: 24, nAvail: 12 }],
  ['VHL', async () => pickName(await L.vhl()), { maxAge: 24, nAvail: 12 }],
  ['MHL', async () => pickName(await L.mhl()), { maxAge: 24, nAvail: 12 }],
  ['SHL', () => L.shl(), { maxAge: 24, nAvail: 12 }],
  ['Allsvenskan', () => L.swe('Allsvenskan'), { maxAge: 24, nAvail: 12 }],
  ['J20', () => L.swe('J20'), { maxAge: 24, nAvail: 12 }],
  ['NCAA', () => L.ncaa(WS.ls), { maxAge: 24, nAvail: 12 }],
  ['Czech', () => L.czech(), { maxAge: 24, nAvail: 12 }],
  ['NHL', () => WS.nhl()(), { ownedSt: ['MINORS'], maxAge: 23, minGP: 1 }],
];

const only = process.argv.slice(2); // optional: node src/scan.js KHL VHL  (debug a subset)
for (const [lg, fn, opts] of jobs) {
  if (only.length && !only.includes(lg)) continue;
  const t0 = Date.now();
  try {
    const r = await WS.run(lg, fn, opts);
    if (r.nSk + r.nG) { add(lg, r); res.status[lg] = 'ok'; }
    else { res.cov[lg] = 'no games yet'; res.status[lg] = 'no games yet'; }
    console.log(`${lg}: ${r.nSk} skaters, ${r.nG} goalies, ${r.matched} matched, ${r.owned.length} owned (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  } catch (e) {
    const why = e.message + (e.cause ? ' (' + (e.cause.code || e.cause.message || e.cause) + ')' : '');
    res.cov[lg] = 'ERR ' + why; res.status[lg] = 'ERR ' + why;
    console.log(`${lg}: FAILED ${why}`);
  }
}

const out = path.join(ROOT, 'data'); fs.mkdirSync(out, { recursive: true });
const doc = JSON.stringify(res);
if (!only.length) { fs.writeFileSync(path.join(out, 'latest.json'), doc); fs.writeFileSync(path.join(out, today + '.json'), doc); }
fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify({ d: today, at: res.at, status: res.status, subset: only }, null, 1));
const bad = Object.entries(res.status).filter(([, v]) => v.startsWith('ERR'));
console.log(`done: ${Object.keys(res.status).length - bad.length} ok, ${bad.length} failed${bad.length ? ': ' + bad.map(([k]) => k).join(', ') : ''}`);
// keep 120 days of daily snapshots
for (const f of fs.readdirSync(out)) { const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/); if (m && (Date.now() - new Date(m[1])) > 120 * 864e5) fs.unlinkSync(path.join(out, f)); }
