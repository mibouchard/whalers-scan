// Offline tests of the shared libraries (no network). Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.WS_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'ws-state-'));
const { skaterFP, goalieFP, gameLogFP } = await import('../src/lib/scoring.js');
const { capOf, counts, rosterWarnings, periodForDate, periodDates, diffMoves, freeMap, namer } = await import('../src/lib/fantrax.js');
const { makeMatcher, nameKey } = await import('../src/lib/names.js');
const { rowsFromGame } = await import('../src/lib/nhl.js');
const { retry, withDeadline } = await import('../src/lib/util.js');
const { plan } = await import('../src/ci/guard.js');
const { mergeByUuid, parseBirth, rosterBirths } = await import('../src/leagues.js');
const { parseHTML } = await import('../src/env.js');
const { splitArgs, torontoDate, isoToronto } = await import('../src/lib/config.js');

test('league scoring', () => {
  // G 3, A 2, PPP 1, SHG 2, GWG 1, +/- 0.5, BLK 0.2, HIT 0.2, PIM 0.25, SOG 0.1
  assert.equal(skaterFP({ g: 1, a: 3, ppp: 0, shg: 0, gwg: 0, pm: 4, sog: 4, hit: 4, blk: 0, pim: 0 }), 12.2);
  assert.equal(skaterFP({ g: 1, a: 1, ppp: 2, shg: 1, gwg: 1, pm: -1, sog: 3, hit: 2, blk: 1, pim: 2 }), 3 + 2 + 2 + 2 + 1 - 0.5 + 0.3 + 0.4 + 0.2 + 0.5);
  // W 5, SO 5, SV 0.25, GA -1; a goalie's assist scores too
  assert.equal(goalieFP({ w: 1, so: 1, sv: 37, ga: 0 }), 19.25); assert.equal(goalieFP({ w: 0, so: 0, sv: 30, ga: 3, a: 1 }), 6.5);
  assert.equal(gameLogFP({ goals: 1, assists: 1, powerPlayPoints: 1, shots: 4, plusMinus: 1, pim: 2 }, { hit: 3, blk: 1 }), 3 + 2 + 1 + 0.4 + 0.5 + 0.5 + 0.6 + 0.2);
  assert.equal(gameLogFP({ shotsAgainst: 30, goalsAgainst: 2, decision: 'W', shutouts: 0 }), 5 + 7 - 2);
});
test('cap: active + reserve + dead cap; minors and IR do not count', () => {
  const list = [{ status: 'ACTIVE', salary: 80e6 }, { status: 'RESERVE', salary: 10e6 }, { status: 'MINORS', salary: 5e6 }, { status: 'INJURED_RESERVE', salary: 12e6 }];
  const c = capOf(list, 'HFD');
  assert.deepEqual(c, { cap: 114.4, active: 80, reserve: 10, dead: 0.588, ir: 12, used: 90.588, room: 23.812, roomAfterIR: 11.812 });
  assert.equal(capOf(list, 'CGY').dead, 0); assert.equal(capOf(list, 'CGY').room, 24.4);
  const n = counts([...Array(14).fill({ status: 'ACTIVE' }), ...Array(7).fill({ status: 'RESERVE' }), ...Array(26).fill({ status: 'MINORS' }), { status: 'INJURED_RESERVE' }]);
  assert.deepEqual(n, { active: 14, reserve: 7, ir: 1, minors: 26, main: 21 });
  assert.deepEqual(rosterWarnings(n, { room: -1.5 }), ['minors 26/25', 'main roster 21/20', 'reserve 7/6', 'over the cap by 1.500M']);
  assert.deepEqual(rosterWarnings(counts([...Array(13).fill({ status: 'ACTIVE' }), ...Array(4).fill({ status: 'RESERVE' })]), { room: 1 }), ['main roster 17, minimum 18', 'active not 14 (13)']);
});
test('periodForDate: the period in effect when a game was played', () => {
  // the shape getLeagueInfo really returns (2026-10-07)
  const info = { scoringPeriods: [{ number: 1, startDate: '2026-09-29T17:00:00.0-0400', endDate: '2026-10-05T18:59:59.0-0400' }, { number: 2, startDate: '2026-10-05T19:00:00.0-0400', endDate: '2026-10-12T12:59:59.0-0400' }, { number: 3, startDate: '2026-10-12T13:00:00.0-0400', endDate: '2026-10-19T18:59:59.0-0400' }] };
  assert.equal(periodForDate('2026-10-03', info), 1); assert.equal(periodForDate('2026-10-04', info), 1);
  assert.equal(periodForDate('2026-10-05', info), 2, 'Monday night games belong to the new period');
  assert.equal(periodForDate('2026-10-05T23:00:00Z', info), 2); assert.equal(periodForDate('2026-10-05T17:00:00Z', info), 1, 'a Monday matinee before the 7 PM change is still the old period');
  assert.equal(periodForDate('2026-10-12', info), 3); assert.equal(periodForDate('2026-10-11', info), 2);
  assert.equal(periodForDate('2026-09-01', info), null); assert.equal(periodForDate('2026-10-06', {}), null, 'no period dates: unknown, the caller falls back');
  assert.deepEqual(periodDates(2, info), { start: '2026-10-05T23:00:00.000Z', end: '2026-10-12T16:59:59.000Z' });
});
test('moves: adds, drops, status and salary changes', () => {
  const prev = { T1: { short: 'HFD', cur: [], next: [['a', 'ACTIVE', 1, 'C', 'A One', 'BOS'], ['b', 'MINORS', 0, 'D', 'B Two', 'NYR'], ['c', 'RESERVE', 2, 'G', 'C Three', 'DAL']] }, T2: { short: 'CGY', cur: [['x', 'ACTIVE', 3, 'C', 'X', 'SEA']], next: null } };
  const now = { T1: { short: 'HFD', cur: [], next: [['a', 'RESERVE', 1, 'C', 'A One', 'BOS'], ['c', 'RESERVE', 2.5, 'G', 'C Three', 'DAL'], ['d', 'MINORS', 0, 'LW', 'D Four', 'UTA']] }, T2: { short: 'CGY', cur: [], next: [['x', 'ACTIVE', 3, 'C', 'X', 'SEA'], ['b', 'MINORS', 0, 'D', 'B Two', 'NYR']] } };
  assert.deepEqual(diffMoves(prev, now), [
    { team: 'HFD', id: 'a', name: 'A One', from: 'ACTIVE', to: 'RESERVE', salaryFrom: 1, salaryTo: 1 },
    { team: 'HFD', id: 'c', name: 'C Three', from: 'RESERVE', to: 'RESERVE', salaryFrom: 2, salaryTo: 2.5 },
    { team: 'HFD', id: 'd', name: 'D Four', from: null, to: 'MINORS', salaryFrom: null, salaryTo: 0 },
    { team: 'HFD', id: 'b', name: 'B Two', from: 'MINORS', to: null, salaryFrom: 0, salaryTo: null },
    { team: 'CGY', id: 'b', name: 'B Two', from: null, to: 'MINORS', salaryFrom: null, salaryTo: 0 },
  ]);
  assert.deepEqual(diffMoves(now, now), []);
});
test('free agents come only from Fantrax status; names fall back to ADP', () => {
  assert.deepEqual(freeMap({ playerInfo: { a: { status: 'FA' }, b: { status: 'T' }, c: { status: 'WW' } } }), { a: 'FA', c: 'WW' });
  assert.equal(freeMap(null), null); assert.equal(freeMap({}), null);
  const name = namer({ a: { name: 'Hughes, Jack' } }, [{ id: 'b', name: 'Makar, Cale' }]); assert.equal(name('a'), 'Jack Hughes'); assert.equal(name('b'), 'Cale Makar'); assert.equal(name('zzz'), null);
});
test('NHL -> Fantrax matcher: full name, then last name + team, and an unmatched list', () => {
  const M = makeMatcher({ a: { name: 'Novak, Thomas', team: 'PIT', position: 'C' }, b: { name: 'Hughes, Jack', team: 'NJD', position: 'C' }, c: { name: 'Hughes, Luke', team: 'NJD', position: 'D' },
    d: { name: 'Pettersson, Elias', team: 'VAN', position: 'C' }, e: { name: 'Pettersson, Elias', team: 'VAN', position: 'D' }, f: { name: 'Aho, Sebastian', team: 'CAR', position: 'C' }, g: { name: 'Aho, Sebastian', team: '(N/A)', position: 'D' }, h: { name: 'Vladar, Daniel', team: 'PHI', position: 'G' } });
  assert.deepEqual(M.find({ first: 'Tommy', last: 'Novak', team: 'PIT', pos: 'C' }), { id: 'a', how: 'last+team' });
  assert.equal(M.find({ first: 'Luke', last: 'Hughes', team: 'NJD', pos: 'D' }).id, 'c'); assert.equal(M.find({ first: 'Jake', last: 'Hughes', team: 'NJD', pos: 'C' }).id, 'b', 'brothers: first initial decides');
  assert.equal(M.find({ first: 'Elias', last: 'Pettersson', team: 'VAN', pos: 'D' }).id, 'e'); assert.equal(M.find({ first: 'Elias', last: 'Pettersson', team: 'VAN', pos: 'C' }).id, 'd');
  assert.equal(M.find({ first: 'Sebastian', last: 'Aho', team: 'CAR', pos: 'C' }).id, 'f'); assert.equal(M.find({ first: 'Sebastian', last: 'Aho', team: 'NYI' }, { strict: true }), null);
  assert.equal(M.find({ first: 'Dan', last: 'Vladar', team: 'PHI', goalie: true }).id, 'h'); assert.equal(M.find({ first: 'Dan', last: 'Vladar', team: 'PHI', pos: 'C' }), null, 'a skater never matches a goalie');
  assert.equal(M.find({ first: 'No', last: 'Body', team: 'SEA', pos: 'C' }), null); assert.ok(M.unmatched.includes('No Body SEA'));
  assert.equal(nameKey('Tim', 'Stützle'), nameKey('Tim', 'Stutzle'));
});
test('box score rows: shutouts, shootouts, game-winners, goalie points', () => {
  const sk = (id, o = {}) => ({ playerId: id, name: { default: 'P' + id }, position: 'C', goals: 0, assists: 0, plusMinus: 0, sog: 1, hits: 0, blockedShots: 0, pim: 0, toi: '15:00', ...o });
  const gk = (id, o = {}) => ({ playerId: id, name: { default: 'G' + id }, toi: '60:00', saveShotsAgainst: '30/30', goalsAgainst: 0, decision: 'W', starter: true, ...o });
  const box = (as, hs, away, home) => ({ awayTeam: { abbrev: 'AAA', score: as }, homeTeam: { abbrev: 'HHH', score: hs }, playerByGameStats: { awayTeam: away, homeTeam: home } });
  const goal = (team, pid, o = {}) => ({ teamAbbrev: { default: team }, playerId: pid, strength: 'ev', assists: [], ...o });
  // 3-1 home win: second home goal is the winner; a power-play goal gives PPP to scorer and assisters
  let rows = rowsFromGame(box(1, 3, { forwards: [sk(1, { goals: 1 })], goalies: [gk(91, { decision: 'L', goalsAgainst: 3, saveShotsAgainst: '27/30' })] }, { forwards: [sk(11, { goals: 2 }), sk(12, { goals: 1, assists: 1 })], defense: [sk(13, { position: 'D', assists: 1 })], goalies: [gk(92, { goalsAgainst: 1, saveShotsAgainst: '29/30', assists: 1 })] }),
    { summary: { scoring: [{ periodDescriptor: { periodType: 'REG' }, goals: [goal('HHH', 11), goal('AAA', 1), goal('HHH', 12, { strength: 'pp', assists: [{ playerId: 13 }] }), goal('HHH', 11, { strength: 'sh' })] }] } });
  const by = id => rows.find(r => r.pid === id);
  assert.equal(by(12).gwg, 1); assert.equal(by(12).ppp, 1); assert.equal(by(13).ppp, 1); assert.equal(by(11).shg, 1); assert.equal(by(11).gwg, 0);
  assert.equal(by(92).fp, 5 + 0.25 * 29 - 1 + 2, 'win + saves - goal against + his assist'); assert.equal(by(92).so, 0); assert.equal(by(91).fp, 0.25 * 27 - 3);
  // 0-0 through overtime, home wins the shootout (final 0-1): both goalies played the whole game without a goal against ->
  // both get the shutout, only the winner gets the win, nobody gets a game-winner
  rows = rowsFromGame(box(0, 1, { forwards: [sk(1)], goalies: [gk(91, { decision: 'O', saveShotsAgainst: '25/25' })] }, { forwards: [sk(11)], goalies: [gk(92, { saveShotsAgainst: '20/20' })] }),
    { summary: { scoring: [{ periodDescriptor: { periodType: 'SO' }, goals: [goal('HHH', 11)] }] } });
  assert.equal(rows.find(r => r.pid === 91).so, 1); assert.equal(rows.find(r => r.pid === 91).fp, 5 + 6.25, 'shootout loss: shutout, no win');
  assert.equal(rows.find(r => r.pid === 92).fp, 5 + 5 + 5); assert.equal(rows.find(r => r.pid === 11).gwg, 0);
  // two goalies share a 2-0 win: neither played the whole game, so no shutout; the backup who never played has no row
  rows = rowsFromGame(box(0, 2, { forwards: [sk(1)], goalies: [gk(91, { decision: 'L', goalsAgainst: 2, saveShotsAgainst: '20/22' })] }, { forwards: [sk(11, { goals: 2 })], goalies: [gk(92, { toi: '40:00', saveShotsAgainst: '15/15' }), gk(93, { toi: '20:00', saveShotsAgainst: '8/8', decision: '', starter: false }), gk(94, { toi: '00:00', decision: '' })] }),
    { summary: { scoring: [{ periodDescriptor: { periodType: 'REG' }, goals: [goal('HHH', 11), goal('HHH', 11)] }] } });
  assert.equal(rows.find(r => r.pid === 92).so, 0); assert.equal(rows.find(r => r.pid === 93).so, 0); assert.equal(rows.find(r => r.pid === 94), undefined);
  // an empty-net goal against after the goalie left: the team allowed a goal, so no shutout for him
  rows = rowsFromGame(box(1, 2, { forwards: [sk(1, { goals: 1 })], goalies: [gk(91, { decision: 'L', goalsAgainst: 2, saveShotsAgainst: '20/22' })] }, { forwards: [sk(11, { goals: 2 })], goalies: [gk(92, { goalsAgainst: 0, saveShotsAgainst: '20/20' })] }),
    { summary: { scoring: [{ periodDescriptor: { periodType: 'REG' }, goals: [goal('HHH', 11), goal('HHH', 11), goal('AAA', 1)] }] } });
  assert.equal(rows.find(r => r.pid === 92).so, 0);
});
test('retry and deadline', async () => {
  let n = 0; assert.equal(await retry(async () => { if (++n < 3) throw new Error('flaky'); return 'ok'; }, 3, { base: 1 }), 'ok'); assert.equal(n, 3);
  n = 0; await assert.rejects(retry(async () => { n++; throw new Error('down'); }, 3, { base: 1 }), /down/); assert.equal(n, 3);
  let aborted = false; const t0 = Date.now();
  await assert.rejects(withDeadline(signal => new Promise((_, rej) => signal.addEventListener('abort', () => { aborted = true; rej(new Error('stopped')); })), 50, 'KHL'), /KHL: deadline of 0s exceeded/);
  assert.ok(aborted, 'the work is told to stop'); assert.ok(Date.now() - t0 < 2000);
  assert.equal(await withDeadline(async () => 7, 1000), 7);
});
test('workflow guard: skip, retry or full', () => {
  const now = new Date('2026-10-07T09:47:00Z'); const ok = Object.fromEntries(['form', 'pool', 'league', 'box', 'alertLate', 'fawatch', 'week'].map(s => [s, 'ok']));
  const st = (o = {}) => ({ d: '2026-10-07', at: '2026-10-07T09:20:00Z', status: { AHL: 'ok' }, errors: {}, subset: [], ...o }); const h = (o = {}) => ({ d: '2026-10-07', steps: { scan: 'ok', ...ok, ...o } });
  assert.equal(plan({ event: 'workflow_dispatch', leagues: '', status: st(), health: h(), now }).mode, 'full', 'the outside timer always runs everything');
  assert.deepEqual(plan({ event: 'workflow_dispatch', leagues: 'KHL VHL', status: st(), health: h(), now }), { mode: 'debug', steps: ['scan'] });
  assert.equal(plan({ event: 'schedule', status: st(), health: h(), now }).mode, 'skip', 'clean scan today: backup stops');
  assert.deepEqual(plan({ event: 'schedule', status: st({ status: { AHL: 'ok', KHL: 'carried 2026-10-06' }, errors: { KHL: 'timeout' } }), health: h(), now }), { mode: 'retry', steps: ['scan'], failedLeagues: ['KHL'] });
  assert.deepEqual(plan({ event: 'schedule', status: st(), health: h({ box: 'ERR: 502' }), now }).steps, ['box']);
  assert.equal(plan({ event: 'schedule', status: st({ at: '2026-10-06T09:20:00Z', d: '2026-10-06' }), health: h(), now }).mode, 'full', 'yesterday\'s scan does not count');
  assert.equal(plan({ event: 'schedule', status: st({ subset: ['KHL'] }), health: h(), now }).mode, 'full', 'a debug subset does not count');
  assert.equal(plan({ event: 'schedule', status: null, health: null, now }).mode, 'full');
  assert.equal(plan({ event: 'schedule', status: { d: '2026-10-07', at: '2026-10-07T09:15:00Z', status: { KHL: 'ERR 503' }, subset: [] }, health: h(), now }).mode, 'retry', 'old-format status.json with an ERR league');
  assert.equal(plan({ event: 'workflow_dispatch', retry: true, status: st(), health: h(), now }).mode, 'skip');
});
test('league helpers: SHL merge by uuid, NCAA birthdates', () => {
  const m = mergeByUuid([{ sid: 'u1', team: 'FBK', gp: 6, g: 2, a: 2, pts: 4 }, { sid: 'u1', team: 'FBK', gp: 6, g: 2, a: 2, pts: 4 }, { sid: 'u2', team: 'LHF', gp: 3, g: 1, a: 0, pts: 1 }, { sid: 'u2', team: 'SAIK', gp: 5, g: 0, a: 2, pts: 2 }], ['gp', 'g', 'a', 'pts']);
  assert.deepEqual(m, [{ sid: 'u1', team: 'FBK', gp: 6, g: 2, a: 2, pts: 4 }, { sid: 'u2', team: 'SAIK', gp: 8, g: 1, a: 2, pts: 3 }]);
  assert.equal(parseBirth('5/28/2009'), '2009-05-28'); assert.equal(parseBirth('2009-05-28'), '2009-05-28'); assert.equal(parseBirth('May 28, 2009'), '2009-05-28'); assert.equal(parseBirth('6-1'), null); assert.equal(parseBirth(''), null);
  const doc = parseHTML('<table><tr><th>No.</th><th>Name</th><th>Yr</th><th>DOB</th></tr><tr><td>4</td><td><a href="/players/career/55555">Landon DuPont</a></td><td>Fr</td><td>5/28/2009</td></tr><tr><td>9</td><td><a href="/players/career/66666">No Date</a></td><td>So</td><td></td></tr></table><table><tr><th>Name</th><th>Ht</th></tr><tr><td><a href="/players/career/77777">X</a></td><td>6-1</td></tr></table>');
  assert.deepEqual(rosterBirths(doc), { 55555: '2009-05-28' });
});
test('arguments and dates', () => {
  assert.deepEqual(splitArgs('"Ottawa Senators" 2026-10-06 late'), ['Ottawa Senators', '2026-10-06', 'late']); assert.deepEqual(splitArgs(''), []); assert.deepEqual(splitArgs(undefined), []);
  assert.equal(torontoDate(new Date('2026-10-07T03:40:00Z')), '2026-10-06', '11:40 PM in Toronto is still the 6th'); assert.equal(torontoDate(new Date('2026-12-07T04:40:00Z')), '2026-12-06');
  assert.equal(isoToronto(new Date('2026-10-07T09:16:23Z')), '2026-10-07T05:16:23-04:00'); assert.equal(isoToronto(new Date('2026-12-07T09:16:23Z')), '2026-12-07T04:16:23-05:00');
});
