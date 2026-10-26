// Draftee pool: every pick of the last four NHL drafts who is a free agent or on waivers in our league, with the lines
// the scoutM method prices him on. Built every morning so the nightly minors review starts from a complete, scored pool
// instead of re-reading 1,300 NHL player pages, and so a partial screen can never pass as a full one: `coverage` says
// how many free draftees there are, how many have an NHL id, a Fantrax id and a fresh player page, and names the rest.
//
// Sources (all public): api-web.nhle.com draft/picks/<year>/all (every pick, no ids), records.nhl.com draft (ids, when it
// answers), the 32 clubs' prospect lists, and state/ws.draftids.json, a permanent pick -> NHL id map that grows every run
// (NHL ids never change). Picks still without an id are looked for in the NHL id blocks the four classes occupy, a few
// hundred pages a run, until every pick has one. Fantrax ids come from getPlayerIds through src/lib/names.js (exact name,
// then last name + draft club, then the Russian spelling fold: Shcherbakov = Scherbakov, Rimashevsky = Rimashevskiy),
// confirmed against the NHL page's name.
//
// Writes data/adhoc/draftees.json:
//   { at, d, coverage: { picks, free, nhlId, fx, pages, missingNhlId: [...], noFx: [...], noPage: [...] },
//     czech: <free draftees with a Czech-league line this season>, rows: [ { y, pk, rd, tm, pos, nid, fx, n, dob,
//     ageModel, half, slot, st (FA/WW), d1: { gp, pts, lg, ppg, chlEq }, cur: { gp, g, a, pts, lg }, nhl: { gp, pts },
//     seasons: [[season, league, gp, g, a, pts], ...] } ] }
//   slot: '1-10' | '11-20' | '21-32' | '33-64' | '65-96' | '97-160' | '161+'.  ageModel: age on Feb 1 of the season's
//   second year (the potential model's convention).  half: 'younger' | 'older' inside his draft class (younger = born
//   mid-March to mid-September of the draft year minus 18).  d1 = the first full season after the draft (null for a pick
//   from the draft just past); chlEq = CHL-equivalent points per game through the scan's NHLe factors (OHL = 1.0),
//   inferred, for leagues the back-test has no cell for.  cur = this season, all leagues summed; lg lists them.
// Run alone:  node src/tools/draftees.js            (ARGS=rescan widens the id-block search even when every pick has an id)
import { loadEngine } from '../env.js';
import { torontoDate, readJSON, writeJSON, NHL_TEAMS } from '../lib/config.js';
import { getLeagueInfo, getPlayerIds } from '../lib/fantrax.js';
import { nhl, seasonId } from '../lib/nhl.js';
import { getJSONr } from '../lib/util.js';
import { makeMatcher, fxSplit, fold, nameKey, rusKey, fxGroup, posGroup } from '../lib/names.js';

const WS = loadEngine();
const today = torontoDate();
const NOW = +seasonId().slice(0, 4);                 // 2026 for 2026-27
const YEARS = [NOW - 3, NOW - 2, NOW - 1, NOW];       // the last four drafts (a June draft belongs to the season that starts after it)
const BUDGET_MS = 14 * 60000; const t0 = Date.now();
const left = () => BUDGET_MS - (Date.now() - t0);
const UA = { headers: { 'User-Agent': 'curl/8.5.0' } };
const notes = [];

// NHLe factors (engine/engine.js NHLE table), to a CHL-equivalent rate with the OHL as 1.0
const NHLE = WS.NHLE || { NL: .459, Czech: .418, Liiga: .441, SHL: .566, KHL: .772, VHL: .30, MHL: .12, Allsvenskan: .297, J20: .09, AHL: .389, ECHL: .15, NCAA: .194, OHL: .144, WHL: .141, QMJHL: .113, USHL: .143, BCHL: .07 };
const LG = { 'NL': 'NL', 'Czechia': 'Czech', 'Liiga': 'Liiga', 'SHL': 'SHL', 'KHL': 'KHL', 'VHL': 'VHL', 'MHL': 'MHL', 'HockeyAllsvenskan': 'Allsvenskan', 'J20 Nationell': 'J20', 'U20 Nationell': 'J20', 'AHL': 'AHL', 'ECHL': 'ECHL', 'NCAA': 'NCAA', 'OHL': 'OHL', 'WHL': 'WHL', 'QMJHL': 'QMJHL', 'USHL': 'USHL', 'BCHL': 'BCHL', 'NHL': 'NHL' };
const slotOf = pk => pk <= 10 ? '1-10' : pk <= 20 ? '11-20' : pk <= 32 ? '21-32' : pk <= 64 ? '33-64' : pk <= 96 ? '65-96' : pk <= 160 ? '97-160' : '161+';

// 1. Every pick of the four drafts
const picks = []; // { y, pk, rd, tm, pos, first, last, club, lg }
for (const y of YEARS) {
  const j = await getJSONr(`https://api-web.nhle.com/v1/draft/picks/${y}/all`, UA);
  for (const p of j.picks || []) {
    if (!p.firstName?.default) continue;          // a forfeited pick has no player
    picks.push({ y, pk: p.overallPick, rd: p.round, tm: p.teamAbbrev, pos: p.positionCode, first: p.firstName.default, last: p.lastName.default, club: p.amateurClubName, lg: p.amateurLeague });
  }
}
console.log('picks:', picks.length, 'in', YEARS.join('-'));

// 2. Pick -> NHL id: the permanent map first, then the records site, then the club prospect lists
const idmap = readJSON('state/ws.draftids.json') || { v: 1, ids: {} };   // ids: { "2025-110": { nid, n } }
const key = p => `${p.y}-${p.pk}`;
const byNameYear = new Map(); for (const p of picks) byNameYear.set(p.y + '|' + nameKey(p.first, p.last), p);
let need = picks.filter(p => !idmap.ids[key(p)]);
if (need.length) {
  for (const y of YEARS) {
    if (!need.some(p => p.y === y)) continue;
    const j = await getJSONr(`https://records.nhl.com/site/api/draft?cayenneExp=${encodeURIComponent(`draftYear=${y}`)}`, UA).catch(e => { notes.push(`records ${y}: ${e.message}`); return null; });
    for (const r of j?.data || []) if (r.playerId && r.overallPickNumber) { const p = picks.find(q => q.y === y && q.pk === r.overallPickNumber); if (p) idmap.ids[key(p)] = { nid: r.playerId, n: `${p.first} ${p.last}`, how: 'records' }; }
  }
  need = picks.filter(p => !idmap.ids[key(p)]);
}
if (need.length) {
  for (const t of NHL_TEAMS) {
    const pr = await nhl(`prospects/${t}`).catch(() => null);
    for (const grp of ['forwards', 'defensemen', 'goalies']) for (const q of pr?.[grp] || []) {
      const k = nameKey(q.firstName?.default, q.lastName?.default);
      for (const y of YEARS) { const p = byNameYear.get(y + '|' + k); if (p && !idmap.ids[key(p)] && (p.tm === t || !NHL_TEAMS.includes(p.tm))) idmap.ids[key(p)] = { nid: q.id, n: `${p.first} ${p.last}`, how: 'prospects' }; }
    }
  }
  need = picks.filter(p => !idmap.ids[key(p)]);
}
// Last resort: walk the id blocks each class occupies (ids are handed out in draft order, so a class is one dense block).
// A few hundred pages a run, only while picks are still missing; found ids are kept for good.
const rescan = /rescan/.test(process.env.ARGS || '') || process.argv.includes('rescan');
if (need.length || rescan) {
  const known = Object.values(idmap.ids).map(x => x.nid).filter(Boolean);
  const blocks = {};
  for (const [k, v] of Object.entries(idmap.ids)) { const y = +k.split('-')[0]; (blocks[y] ||= []).push(v.nid); }
  const scanned = new Set(idmap.scanned || []);
  const cands = [];
  for (const y of YEARS) {
    const ids = (blocks[y] || []).sort((a, b) => a - b); if (!ids.length) continue;
    const lo = ids[Math.floor(ids.length * .05)] - 150, hi = ids[Math.floor(ids.length * .95)] + 400;   // late picks sit above the block
    for (let i = lo; i <= hi; i++) if (!known.includes(i) && !scanned.has(i)) cands.push(i);
  }
  console.log('id-block search:', need.length, 'picks without an id,', cands.length, 'candidate ids');
  let i = 0, found = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (i < cands.length && left() > 5 * 60000 && (need.length || rescan)) {
      const nid = cands[i++];
      const d = await getJSONr(`https://api-web.nhle.com/v1/player/${nid}/landing`, UA).catch(e => (/404/.test(e.message) ? null : 'ERR'));
      if (d === 'ERR') continue;
      scanned.add(nid); if (!d?.draftDetails) continue;
      const p = picks.find(q => q.y === d.draftDetails.year && q.pk === d.draftDetails.overallPick);
      if (p && !idmap.ids[key(p)]) { idmap.ids[key(p)] = { nid, n: `${p.first} ${p.last}`, how: 'block' }; found++; need = picks.filter(q => !idmap.ids[key(q)]); }
    }
  }));
  idmap.scanned = [...scanned].sort((a, b) => a - b);
  console.log('id-block search found', found, 'ids;', need.length, 'picks still without one');
}
idmap.at = new Date().toISOString();
writeJSON('state/ws.draftids.json', idmap);

// 3. Who is free right now (Fantrax's own status), and his Fantrax id
const info = await getLeagueInfo();
const pinfo = info.playerInfo; if (!pinfo) throw new Error('getLeagueInfo has no playerInfo: free-agent status unknown, draftees not written');
const ids = await getPlayerIds();
const M = makeMatcher(ids);
// loose key on top of rusKey: Shcherbakov = Scherbakov, Kulebiakin = Kulebyakin, Simashev's ARI tag = UTA
const loose = (f, l) => rusKey(f, l).replace(/shch/g, 'sch').replace(/ye/g, 'e').replace(/ia/g, 'ya').replace(/iu/g, 'yu').replace(/ya$/g, 'ia');
const MOVED = { ARI: 'UTA' };
const byRus = {}; for (const [id, p] of Object.entries(ids)) { const [f, l] = fxSplit(p.name); (byRus[loose(f, l)] ||= []).push({ id, team: p.team || '', pos: p.position || '' }); }
const fxFor = p => {
  const g = posGroup(p.pos);
  let m = M.find({ first: p.first, last: p.last, team: p.tm, pos: p.pos, goalie: p.pos === 'G' }, { strict: true });
  if (m) return { fx: m.id, how: m.how || 'name' };
  // Russian / transliteration fold, then the draft club or an empty club tag has to agree, and the position group
  const tm = MOVED[p.tm] || p.tm;
  const c = (byRus[loose(p.first, p.last)] || []).filter(x => (!x.team || x.team === '(N/A)' || x.team === tm) && (!g || fxGroup(x.pos) === g));
  return c.length === 1 ? { fx: c[0].id, how: 'rus' } : null;
};
const rows = []; const noFx = [];
for (const p of picks) {
  const m = fxFor(p); if (!m) { noFx.push(`${p.y} #${p.pk} ${p.first} ${p.last} (${p.tm})`); continue; }
  const st = pinfo[m.fx]?.status; if (!['FA', 'WW'].includes(st)) continue;
  rows.push({ ...p, fx: m.fx, fxHow: m.how, st, nid: idmap.ids[key(p)]?.nid || null });
}
console.log('free draftees:', rows.length, '| picks with no Fantrax id:', noFx.length);

// 4. Player pages for the free ones (season lines in every league), six at a time
const season = +`${NOW}${NOW + 1}`;
const seasonsOf = d => (d.seasonTotals || []).filter(s => s.gameTypeId === 2 && s.season >= (YEARS[0] - 1) * 10001).map(s => [s.season, s.leagueAbbrev, s.gamesPlayed || 0, s.goals || 0, s.assists || 0, s.points || 0]);
const sumLine = (ss, sea) => { const x = ss.filter(s => s[0] === sea); const gp = x.reduce((a, s) => a + s[2], 0); const g = x.reduce((a, s) => a + s[3], 0), as = x.reduce((a, s) => a + s[4], 0); const main = x.length ? x.reduce((a, s) => s[2] > a[2] ? s : a)[1] : null; return { gp, g, a: as, pts: g + as, lg: [...new Set(x.map(s => s[1]))].join('/') || null, main }; };
const noPage = []; let done = 0, k = 0;
const todo = rows.filter(r => r.nid);
await Promise.all(Array.from({ length: 6 }, async () => {
  while (k < todo.length) {
    if (left() < 60000) { noPage.push('budget: ' + (todo.length - k) + ' pages not fetched'); k = todo.length; break; }
    const r = todo[k++];
    try {
      const d = await getJSONr(`https://api-web.nhle.com/v1/player/${r.nid}/landing`, UA);
      const same = (a, b) => { a = loose('', a).replace(/ /g, ''); b = loose('', b).replace(/ /g, ''); return a === b || a.endsWith(b) || b.endsWith(a); };   // Susuyev = Susuev, Raftheim = Hedin Raftheim
      if (!same(d.lastName?.default, r.last)) { noPage.push(`${r.y} #${r.pk} ${r.first} ${r.last}: NHL id ${r.nid} is ${d.firstName?.default} ${d.lastName?.default}`); r.nid = null; continue; }
      r.dob = d.birthDate || null; r.pos = d.position || r.pos;
      const ss = seasonsOf(d); r.seasons = ss;
      const d1s = +`${r.y}${r.y + 1}`; const d1 = r.y < NOW ? sumLine(ss, d1s) : null;
      if (d1) { d1.ppg = d1.gp ? +(d1.pts / d1.gp).toFixed(2) : null; const f = NHLE[LG[d1.main] || d1.main]; d1.chlEq = d1.ppg != null && f ? +(d1.ppg * f / NHLE.OHL).toFixed(2) : null; d1.n = d1.gp >= 20 ? 'ok' : d1.gp ? 'short' : 'none'; }
      r.d1 = d1; r.cur = sumLine(ss, season);
      const nh = ss.filter(s => s[1] === 'NHL'); r.nhl = { gp: nh.reduce((a, s) => a + s[2], 0), pts: nh.reduce((a, s) => a + s[5], 0) };
      done++;
    } catch (e) { noPage.push(`${r.y} #${r.pk} ${r.first} ${r.last}: ${e.message}`); }
  }
}));
for (const r of rows) if (!r.nid) noPage.push(`${r.y} #${r.pk} ${r.first} ${r.last}: no NHL id yet`);

// 5. Shape, ages, slots
const feb1 = new Date(Date.UTC(NOW + 1, 1, 1));
const out = [];
for (const r of rows) {
  const dob = r.dob ? new Date(r.dob + 'T00:00:00Z') : null;
  const ageModel = dob ? Math.round((feb1 - dob) / (365.25 * 864e5) * 10) / 10 : null;
  // younger half of the class: born Mar 16 to Sep 15 of (draft year - 18); older: Sep 16 (year - 19) to Mar 15
  const half = dob ? ((dob.getUTCFullYear() === r.y - 18 && dob.toISOString().slice(5, 10) >= '03-16' && dob.toISOString().slice(5, 10) <= '09-15') ? 'younger' : 'older') : null;
  out.push({ y: r.y, pk: r.pk, rd: r.rd, tm: r.tm, pos: r.pos, nid: r.nid, fx: r.fx, fxHow: r.fxHow, n: `${r.first} ${r.last}`, dob: r.dob || null, ageModel, half, slot: slotOf(r.pk), st: r.st, d1: r.d1 || null, cur: r.cur || null, nhl: r.nhl || null, seasons: r.seasons || null });
}
out.sort((a, b) => a.y - b.y || a.pk - b.pk);
const czech = out.filter(r => r.cur?.lg && /Czech/.test(r.cur.lg)).length;
const coverage = { picks: picks.length, free: out.length, nhlId: out.filter(r => r.nid).length, fx: picks.length - noFx.length, pages: done, missingNhlId: picks.filter(p => !idmap.ids[key(p)]).map(p => `${p.y} #${p.pk} ${p.first} ${p.last} (${p.tm})`), noFx, noPage };
const res = { at: new Date().toISOString(), d: today, years: YEARS, coverage, czech, notes, rows: out };
writeJSON('data/adhoc/draftees.json', res);
console.log(`draftees: ${out.length} free of ${picks.length} picks; pages ${done}/${out.length}; no NHL id ${coverage.missingNhlId.length}; no Fantrax id ${noFx.length}; Czech lines ${czech};`, notes.join('; ') || 'no notes');
if (done < out.length * 0.95) throw new Error(`draftees: only ${done} of ${out.length} free draftees have a fresh page (${coverage.missingNhlId.length} picks without an NHL id, ${noPage.length} page problems)`);
