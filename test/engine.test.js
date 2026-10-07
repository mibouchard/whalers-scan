// Offline tests of the engine: draft status, name matching guards, list building. No network: Fantrax is a small
// synthetic pool handed to the engine. Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.WS_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-state-'));
const { loadEngine } = await import('../src/env.js');
const { nameKey, rusKey, rusOrderedKey, lastTeamKey, fold } = await import('../src/lib/names.js');
const WS = loadEngine();

const L = i => String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + i % 26);
// a Fantrax pool: [id, 'Last, First', NHL club, position]
const POOL = [
  ['06hrk', 'Dupont, Landon', '(N/A)', 'D'], ['aaaa1', 'Jarvis, Henri', 'CAR', 'C'], ['aaaa2', 'Ryan, James', 'BOS', 'LW'], ['aaaa3', 'Isayev, Dmitry', '(N/A)', 'RW'],
  ['aaaa4', 'Kuznetsov, Yan', 'CGY', 'D'], ['aaaa5', 'Smith, Carter', 'TOR', 'G'], ['aaaa6', "O'Brien, Jean-Luc", 'MTL', 'C'], ['aaaa7', 'Flex, Player', 'NYR', 'D'],
  ['aaaa8', 'Young, Known', 'DET', 'C'], ['aaaa9', 'Age, Noage', 'DET', 'C'], ['aaab1', 'Taken, Already', 'DET', 'C'], ['aaab4', 'Duda, Artyom', 'UTA', 'D'], ['aaab5', 'Shilov, Yegor', '(N/A)', 'C'], ['aaab6', 'Bolduc, Zack', 'MTL', 'RW'], ['aaab2', 'Twin, Sam', 'DAL', 'C'], ['aaab3', 'Twin, Sam', 'SEA', 'C'],
  // (names differ by a letter: digits are not part of a name key)
  ...Array.from({ length: 20 }, (_, i) => ['g' + String(i).padStart(4, '0'), `Goalie${L(i)}, Owned`, 'OTT', 'G']), ...Array.from({ length: 30 }, (_, i) => ['f' + String(i).padStart(4, '0'), `Goalie${L(i)}, Free`, 'OTT', 'G']),
];
function fakeFx() {
  const fx = { pool: {}, rus: {}, rusOrd: {}, lastTeam: {}, byId: {}, own: {}, notes: [], period: 2, ownPeriod: 3, elig: { aaaa7: 'D,RW' } };
  for (const [id, name, team, pos] of POOL) { const [last, first] = name.split(', '); const c = [id, team, pos]; (fx.pool[nameKey(first, last)] ||= []).push(c); (fx.rus[rusKey(first, last)] ||= []).push(c); (fx.rusOrd[rusOrderedKey(first, last)] ||= []).push(c); if (team !== '(N/A)') (fx.lastTeam[lastTeamKey(last, team)] ||= []).push([...c, fold(first)[0]]); fx.byId[id] = [first + ' ' + last, team, pos]; }
  fx.own.aaab1 = ['CGY', 'MINORS']; for (let i = 0; i < 20; i++) fx.own['g' + String(i).padStart(4, '0')] = [i === 7 ? 'HFD' : 'BOS', 'MINORS'];
  return fx;
}
const sk = (first, last, o = {}) => ({ sid: first + last, first, last, pos: 'F', team: 'X', gp: 5, g: 2, a: 3, pts: 5, ppp: 1, ...o });
const collect = (lg, rows) => WS.collect(lg, async () => rows, { fx: fakeFx(), noTrend: true });
const col = (s, k, cols = WS.SK) => s.split('|')[cols.indexOf(k)];

test('draft status: an NCAA freshman with only a class-year age is unknown, never "post"', async () => {
  // Landon DuPont, Michigan, D: 2027-eligible. The NCAA adapter estimates 19 from "Fr"; before the fix that produced dr = 'post'.
  const { rows } = await collect('NCAA', [sk('Landon', 'DuPont', { pos: 'D', team: 'Michigan', age: 19, gp: 2, pts: 2 })]);
  const r = rows[0]; assert.equal(r.fx, '06hrk'); assert.equal(r.ak, 'est');
  const out = WS.summarize('NCAA', rows, { minGP: 1, undMaxAge: 24, free: () => true });
  console.log('DuPont, class-year age only   ->', JSON.stringify({ fx: r.fx, age: r.age, ak: r.ak, org: r.org, dr: r.dr }), '| und row:', out.undrafted[0]);
  assert.equal(r.dr, ''); assert.equal(col(out.undrafted[0], 'dr'), ''); assert.equal(col(out.undrafted[0], 'ak'), 'est');
  // with his real birthdate (roster page) he is 'pre': not yet through a draft, never claimable
  const b = (await collect('NCAA', [sk('Landon', 'DuPont', { pos: 'D', team: 'Michigan', age: 19, dob: '2009-05-28' })])).rows[0]; WS.summarize('NCAA', [b]);
  console.log('DuPont, real birthdate 2009-05-28 ->', JSON.stringify({ age: b.age, ak: b.ak, dr: b.dr }), '| cutoff', WS.draftCutoff('2026-10-07'));
  assert.equal(b.dr, 'pre'); assert.equal(b.ak, 'dob');
});
test('draft status rules', () => {
  const ref = '2026-10-07';
  assert.equal(WS.draftCutoff(ref), '2008-09-15'); assert.equal(WS.draftCutoff('2027-06-20'), '2008-09-15'); assert.equal(WS.draftCutoff('2027-07-02'), '2009-09-15');
  assert.equal(WS.draftStatus({ org: '(N/A)', dob: '2008-09-16' }, ref), 'pre');
  assert.equal(WS.draftStatus({ org: '(N/A)', dob: '2008-09-15' }, ref), 'post');
  assert.equal(WS.draftStatus({ org: 'BOS', age: 17 }, ref), 'post');           // an NHL club holds him
  assert.equal(WS.draftStatus({ org: 'BOS', mq: 'amb', age: 19 }, ref), '');   // ...unless the match itself is doubtful
  assert.equal(WS.draftStatus({ org: 'BOS', mq: 'amb', dob: '2009-01-01' }, ref), 'pre');
  for (const age of [16, 17, 19, 22, null]) assert.equal(WS.draftStatus({ org: null, age }, ref), '', 'estimated or missing age: unknown'); // Czech bands, NCAA classes, no age
});
test('name matching: exact outside Russia, folded inside', async () => {
  const fx = fakeFx(); const id = (lg, f, l, pos = 'F', team) => { const m = WS.match(fx, f, l, pos, lg, team); return m && m.id ? m.id : m && m.rej ? 'REJECTED' : null; };
  assert.equal(id('OHL', 'Henri', 'Jarvis'), 'aaaa1'); assert.equal(id('OHL', 'Henry', 'Jarvis'), null);          // Henry != Henri
  assert.equal(id('OHL', 'James', 'Ryan'), 'aaaa2'); assert.equal(id('OHL', 'Ryan', 'James'), null);              // word order matters
  assert.equal(id('KHL', 'Dmitri', 'Isayev'), 'aaaa3'); assert.equal(id('MHL', 'Dmitriy', 'Isayev'), 'aaaa3');    // Russian spellings fold
  assert.equal(id('OHL', 'Dmitriy', 'Isayev'), 'aaaa3'); assert.equal(id('OHL', 'Isayev', 'Dmitriy'), null);      // elsewhere a Russian given name still folds, but word order is kept
  assert.equal(id('OHL', 'Artem', 'Duda', 'D'), 'aaab4'); assert.equal(id('AHL', 'Egor', 'Shilov'), 'aaab5');           // Artem = Artyom, Egor = Yegor
  assert.equal(id('NHL', 'Zachary', 'Bolduc', 'R', 'MTL'), 'aaab6'); assert.equal(id('AHL', 'Zachary', 'Bolduc', 'R', 'MTL'), null); // NHL rows: last name + club + initial
  assert.equal(id('NHL', 'Zachary', 'Bolduc', 'R', 'BOS'), null);
  assert.equal(id('AHL', 'Jean Luc', 'OBrien'), 'aaaa6'); assert.equal(id('AHL', 'Jean-Luc', "O'Brien"), 'aaaa6'); // accents, apostrophes, hyphens
  assert.equal(id('MHL', 'Yan', 'Kuznetsov', 'F'), 'REJECTED'); assert.equal(id('NHL', 'Yan', 'Kuznetsov', 'D'), 'aaaa4'); // forward never matches a Fantrax D
  assert.equal(id('AHL', 'Player', 'Flex', 'F'), 'aaaa7');                                                        // Fantrax eligible at D and RW: no guard
  assert.equal(id('AHL', 'Carter', 'Smith', 'F'), null); assert.equal(id('AHL', 'Carter', 'Smith', 'G'), 'aaaa5'); // goalie only matches goalie
  assert.equal(WS.match(fx, 'Sam', 'Twin', 'C', 'AHL').q, 'amb'); assert.equal(WS.match(fx, 'Sam', 'Twin', 'C', 'NHL', 'SEA').id, 'aaab3'); // namesakes: ambiguous unless the NHL club decides
});
test('lists: free agents only, unknown ages last, no Fantrax id = not a free agent, blank NHLe at 0 GP', async () => {
  const rows = [sk('Known', 'Young', { age: 20, dob: '2006-01-01', pts: 3 }), sk('Noage', 'Age', { pts: 9 }), sk('Already', 'Taken', { age: 20 }), sk('Nobody', 'Unlisted', { age: 18, dob: '2008-01-01', pts: 9 }),
    sk('Landon', 'DuPont', { pos: 'D', age: 19, gp: 0, g: 0, a: 0, pts: 0 }), sk('Sam', 'Twin', { pos: 'C', age: 20, dob: '2006-02-02', pts: 9 })];
  const c = await collect('AHL', rows);
  const all = WS.summarize('AHL', c.rows, { minGP: 1, free: () => true });
  assert.deepEqual(all.avail.map(s => col(s, 'name')), ['Known Young', 'Noage Age'], 'age-known row first even with fewer points; ambiguous namesake (Sam Twin) left out');
  assert.equal(col(all.avail[1], 'ak'), ''); assert.equal(col(all.avail[0], 'ak'), 'dob');
  assert.deepEqual(all.owned.map(s => col(s, 'name')), ['Already Taken']);
  assert.deepEqual(all.notInFx.map(s => col(s, 'name')), ['Nobody Unlisted']);
  for (const k of ['avail', 'undrafted', 'risers']) assert.ok(!all[k].some(s => !col(s, 'fx')), k + ' never lists a row without a Fantrax id');
  const none = WS.summarize('AHL', c.rows, { minGP: 1, free: () => false });
  assert.equal(none.avail.length + none.undrafted.length + none.risers.length, 0, 'Fantrax status unknown or not FA/WW: nothing is listed as free'); assert.equal(none.owned.length, 1);
  const zero = c.rows.find(r => r.last === 'DuPont'); assert.equal(zero.nhle, null); assert.equal(zero.gem, null);
  assert.equal(col(WS.summarize('AHL', c.rows, { minGP: 0, undMaxAge: 24, free: () => true }).undrafted.find(s => /DuPont/.test(s)), 'nhle'), '');
});
test('goalies: every owned goalie is kept, only the unowned list is cut', async () => {
  const rows = [...Array.from({ length: 20 }, (_, i) => ({ goalie: 1, sid: 'o' + i, first: 'Owned', last: 'Goalie' + L(i), pos: 'G', team: 'X', gp: 3, svp: (0.8 + i / 1000).toFixed(3), dob: '2004-01-01' })),
    ...Array.from({ length: 30 }, (_, i) => ({ goalie: 1, sid: 'u' + i, first: 'Free', last: 'Goalie' + L(i), pos: 'G', team: 'X', gp: 3, svp: (0.9 + i / 1000).toFixed(3), dob: '2004-01-01' }))];
  const out = WS.summarize('AHL', (await collect('AHL', rows)).rows, { minGP: 1, free: () => true });
  const owned = out.goalies.filter(s => col(s, 'own', WS.GK));
  console.log(`goalies: ${owned.length} owned kept (was cut at 14 in total), ${out.goalies.length - owned.length} unowned listed; HFD goalie present: ${out.goalies.some(s => col(s, 'own', WS.GK) === 'HFD')}`);
  assert.equal(owned.length, 20); assert.equal(out.goalies.length, 34); assert.ok(out.goalies.some(s => col(s, 'own', WS.GK) === 'HFD'));
});
test('column order: only appended, never reordered', () => {
  assert.deepEqual(WS.SK.slice(0, 20), ['fx', 'own', 'st', 'name', 'team', 'pos', 'age', 'gp', 'g', 'a', 'pts', 'ppp', 'ppg', 'nhle', 'prev', 'yoy', 'tr', 'rgp', 'toi', 'dr']);
  assert.deepEqual(WS.SK.slice(20), ['ak', 'mq']);
  assert.deepEqual(WS.GK.slice(0, 11), ['fx', 'own', 'st', 'name', 'team', 'age', 'gp', 'svp', 'gaa', 'w', 'min']); assert.deepEqual(WS.GK.slice(11), ['ak', 'mq']);
});
