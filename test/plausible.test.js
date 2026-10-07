// Offline test of the cross-league plausibility check, over rows frozen from the 2026-10-07 scan (before the check
// existed): data/latest.json and the duplicate-id rows of data/adhoc/fawatch.json. Known false pairs must be resolved
// and genuine farm pairs must survive. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { recsFromDoc, crossCheck, makeCohort, applyToDoc, DOB_LEAGUES } from '../src/lib/plausible.js';
import { fxGroup, posGroup } from '../src/lib/names.js';

const fix = f => JSON.parse(fs.readFileSync(new URL('./fixtures/' + f, import.meta.url)));
const doc = fix('latest-2026-10-07.json'), fw = fix('fawatch-dupes-2026-10-07.json'), pos = fix('fx-positions.json').ids, cohort = makeCohort(fix('idcohort-2026-10-07.json').b);

function run() {
  const recs = recsFromDoc(doc);
  const have = new Set(recs.map(r => `${r.lg}|${r.fx}|${r.team}`));
  for (const s of fw.skaters) if (!have.has(`${s.lg}|${s.fx}|${s.team}`)) {
    const ak = s.age == null ? '' : DOB_LEAGUES.has(s.lg) ? 'dob' : 'est';
    recs.push({ lg: s.lg, fx: s.fx, name: s.name, team: s.team, g: posGroup(s.pos), age: s.age, ak, by: ak === 'dob' ? 2026 - s.age : null, dob: null, gp: s.gp, org: '', own: '', ref: { fw: s } });
  }
  const rep = crossCheck(recs, { cohort, year: 2026, fxGroup: id => pos[id] ? fxGroup(pos[id][0]) : '' });
  return { recs, rep };
}
const { recs, rep } = run();
const of = (fx) => recs.filter(r => r.fx === fx);
const state = r => r.drop ? 'DROPPED' : r.amb ? 'AMBIGUOUS' : r.vet ? 'VETERAN(no age)' : 'kept';
const show = fx => { const seen = new Set(); return of(fx).filter(r => { const k = r.lg + r.team; if (seen.has(k)) return false; seen.add(k); return true; }).map(r => `${r.lg} ${r.name} ${r.team} ${r.g || '?'} ${r.age ?? 'no age'} -> ${state(r)}${r.drop ? ' (' + r.drop + ')' : ''}`); };
const st = (fx, lg, team) => { const r = of(fx).find(x => x.lg === lg && (!team || x.team === team)); assert.ok(r, `row ${fx} ${lg} ${team || ''} present in the fixture`); return state(r); };

test('report', () => {
  const cases = { '0618l': 'Yegor Sidorov', '05xyi': 'Tucker Robertson', '04zp5': 'Ryan Johnson', '0760j': 'Adam Nemec', '0760o': 'Cooper Williams', '06ydu': 'Liam Kilfoil', '05kj8': 'Yan Kuznetsov', '05tql': 'Anton Olsson', '03xms': 'Tyler Kelleher', '06mcs': 'Matvei Korotky (genuine KHL/VHL)', '06mcw': 'Jack Berglund (genuine)', '06tmr': 'Dmitry Isayev (genuine KHL/VHL/MHL)', '06hri': 'Cole Beaudoin (genuine AHL/NHL)', '075u7': 'Alexander Command (genuine SHL/J20)' };
  for (const [fx, label] of Object.entries(cases)) { console.log(`${fx} ${label}`); for (const l of show(fx)) console.log('    ' + l); }
  console.log(`totals: ${rep.dropped.length} dropped, ${rep.ambiguous.length} ambiguous ids, ${rep.veteran.length} veteran-id rows with no age`);
});
test('namesakes lose the match', () => {
  assert.equal(st('0618l', 'AHL'), 'kept'); assert.equal(st('0618l', 'VHL'), 'DROPPED');          // Sidorov: AHL SD is real, VHL Kristall is a namesake
  assert.equal(st('05xyi', 'AHL'), 'kept'); assert.equal(st('05xyi', 'WHL'), 'DROPPED');          // Robertson: AHL 23 vs WHL 19
  assert.equal(st('04zp5', 'AHL'), 'kept'); assert.equal(st('04zp5', 'NCAA'), 'DROPPED');         // Johnson: AHL D vs NCAA F
  assert.equal(st('06ydu', 'QMJHL'), 'kept'); assert.equal(st('06ydu', 'WHL'), 'DROPPED');        // Kilfoil: QMJHL C 19 vs WHL D 17
  assert.equal(st('05kj8', 'NHL'), 'kept'); assert.equal(st('05kj8', 'MHL'), 'DROPPED');          // Kuznetsov: NHL CGY D 24 vs MHL F
  assert.equal(st('05tql', 'Liiga'), 'kept'); assert.equal(st('05tql', 'Allsvenskan'), 'DROPPED'); // Olsson: Liiga (birthdate) vs Allsvenskan (none)
});
test('pairs that cannot be told apart are tagged, not guessed', () => {
  assert.equal(st('0760j', 'OHL', 'SBY'), 'AMBIGUOUS'); assert.equal(st('0760j', 'OHL', 'BFD'), 'AMBIGUOUS'); // Nemec: two OHL rows, 18 / 17
  assert.equal(st('0760o', 'WHL'), 'AMBIGUOUS'); assert.equal(st('0760o', 'OHL'), 'AMBIGUOUS');               // Williams: WHL 18 vs OHL 19
});
test('a row with no age on a veteran Fantrax id is not an under-24 target', () => {
  assert.equal(st('03xms', 'Allsvenskan'), 'VETERAN(no age)'); // Tyler Kelleher, about 31
});
test('genuine farm pairs survive', () => {
  for (const [fx, lgs] of Object.entries({ '06mcs': ['KHL', 'VHL'], '06tmr': ['KHL', 'VHL', 'MHL'], '06hri': ['AHL', 'NHL'], '075u7': ['SHL', 'J20'], '05yfk': ['KHL', 'VHL'], '06sn3': ['VHL', 'MHL'], '06tas': ['SHL', 'J20', 'Allsvenskan'], '05ufk': ['KHL', 'VHL'] }))
    for (const lg of lgs) assert.equal(st(fx, lg), 'kept', `${fx} ${lg}`);
  assert.equal(st('06mcw', 'SHL'), 'kept'); // Berglund
});
test('applying the marks to the saved document', () => {
  const copy = structuredClone(doc); copy.cols.sk.push('ak', 'mq');
  const r2 = recsFromDoc(copy); crossCheck(r2, { cohort, year: 2026, fxGroup: id => pos[id] ? fxGroup(pos[id][0]) : '' }); applyToDoc(copy, r2);
  const has = (list, re) => copy[list].some(s => re.test(s));
  assert.ok(!has('owned', /^VHL\|0618l\|/), 'VHL Sidorov namesake gone from owned'); assert.ok(has('owned', /^AHL\|0618l\|HFD\|/), 'AHL Sidorov still owned by HFD');
  assert.ok(!has('owned', /^WHL\|05xyi\|/)); assert.ok(!has('owned', /^NCAA\|04zp5\|/));
  assert.ok(!has('avail', /Tyler Kelleher/), 'Kelleher out of avail'); assert.ok(!has('avail', /^MHL\|05kj8\|/), 'MHL Kuznetsov out of avail');
  const nemec = copy.owned.filter(s => /\|0760j\|/.test(s)); assert.equal(nemec.length, 2); for (const s of nemec) assert.equal(s.split('|')[copy.cols.sk.indexOf('mq')], 'amb');
  assert.ok(has('owned', /^KHL\|06mcs\|HFD\|/) && has('owned', /^VHL\|06mcs\|HFD\|/), 'Korotky KHL and VHL both kept');
});
