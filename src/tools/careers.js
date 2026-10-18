// Past seasons, season by season, for the Front Office player card's Stats tab. Run by hand (One-off tool, tool=careers)
// once a season, or when many new players have come into the league; the current season is not stored here (stats.js
// writes it every morning).
//
// Who: every player on a roster in our league (this period and next) plus every free agent who played an NHL game in
// the last three seasons. Fantrax id -> NHL id from NHL club rosters, club prospect lists and the NHL's season reports,
// matched by name (src/lib/names.js, strict) and checked against the NHL's own name for that id.
// What: every regular-season NHL season (hits and blocked shots from the NHL's season reports, since 2005-06), plus
// regular seasons in other leagues from 2019-20 on (junior, college, AHL, Europe) for the development path. Youth hockey
// and international tournaments are left out.
//
// Writes data/fo/careers-0.json .. careers-7.json (src/lib/fostats.js chunkOf picks the file):
//   { at, through, chunk, of, cols: { sk: [...], g: [...] }, p: { <fantraxId>: { nid, n, g?: 1, r: [[...], ...] } } }
//   skater row: [year, league, team, gp, g, a, pm, pim, sog, ppp, shg, gwg, hit, blk, toi]   (toi = seconds per game)
//   goalie row: [year, league, team, gp, gs, w, l, otl, ga, sa, so, toi]                       (toi = seconds, total)
//   year is the season's first year (2025 = 2025-26); a value the source does not have is null. Newest season first.
import { readJSON, writeJSON, NHL_TEAMS } from '../lib/config.js';
import { getPlayerIds } from '../lib/fantrax.js';
import { nhl, clubRoster, seasonId, sec } from '../lib/nhl.js';
import { getJSONr } from '../lib/util.js';
import { makeMatcher, fxSplit, nameKey, fold } from '../lib/names.js';
import { CHUNKS, chunkOf, careersPath, report, byPlayer } from '../lib/fostats.js';

const NOW = +seasonId().slice(0, 4);                 // current season's first year: not stored here
const FROM_OTHER = 2019;                              // other leagues: 2019-20 on
const YOUTH = /bantam|midget|minor|peewee|prep|\bhs\b|high school|\baaa\b|u-?1[0-8]\b|wjc|wj18|wjac|whc|\bwc\b|^og$|olympic|hlinka|4 nations|world|international|tournament|exhib|friendly|cwg|youth|cup|challenge|showcase|classic/i;   // league codes left out

const ids = await getPlayerIds();
const M = makeMatcher(ids);
const L = readJSON('data/league.json');
if (!L?.teams) throw new Error('data/league.json has no rosters: run the league tool first');

// 1. Our league's rostered players (this period and next)
const rostered = new Set();
for (const t of Object.values(L.teams)) for (const x of [t.cur, t.next]) for (const r of x || []) rostered.add(r[0]);
const free = new Set(Object.keys(L.free || {}));

// 2. NHL people: club rosters and prospect lists first (current clubs), then the season reports (anyone who played lately)
const people = []; // { nid, first, last, team, pos, src }
for (const t of NHL_TEAMS) {
  for (const [nid, p] of Object.entries(await clubRoster(t))) people.push({ nid: +nid, first: p.first, last: p.last, team: t, pos: p.pos, src: 'roster' });
  const pr = await nhl(`prospects/${t}`).catch(() => null);
  for (const grp of ['forwards', 'defensemen', 'goalies']) for (const p of pr?.[grp] || []) people.push({ nid: p.id, first: p.firstName?.default, last: p.lastName?.default, team: t, pos: p.positionCode, src: 'prospect' });
}
const recentGp = {};
for (let y = NOW - 3; y <= NOW; y++) {
  const s = `${y}${y + 1}`;
  for (const [kind, name] of [['skater/summary', 'skaterFullName'], ['goalie/summary', 'goalieFullName']]) {
    for (const r of await report(kind, s)) {
      const full = r[name] || '', last = r.lastName || full.split(' ').slice(-1)[0], first = full.slice(0, full.length - last.length).trim();
      const team = String(r.teamAbbrevs || '').split(',').pop();
      people.push({ nid: r.playerId, first, last, team, pos: kind.startsWith('goalie') ? 'G' : r.positionCode, src: 'report' });
      if (y < NOW) recentGp[r.playerId] = (recentGp[r.playerId] || 0) + (r.gamesPlayed || 0);
    }
  }
}

// Unsigned draft picks are on no club list: the NHL records site lists every pick with his NHL id (2019 on)
const notes = [];
for (let y = 2019; y <= NOW; y++) {
  const j = await getJSONr(`https://records.nhl.com/site/api/draft?cayenneExp=${encodeURIComponent(`draftYear=${y}`)}`).catch(e => { notes.push(`draft ${y}: ${e.message}`); return null; });
  for (const r of j?.data || []) {
    if (!r.playerId) continue;
    const last = r.lastName || String(r.playerName || '').split(' ').slice(-1)[0], first = r.firstName || String(r.playerName || '').slice(0, -last.length).trim();
    people.push({ nid: r.playerId, first, last, team: r.triCode || r.teamAbbrev || '', pos: r.position || r.positionCode || '', src: 'draft' });
  }
}

// 3. Fantrax id -> NHL id (first source wins; an id claimed by two NHL players is dropped)
const fx2nid = {}, clash = new Set();
for (const q of people) {
  const m = M.find({ first: q.first, last: q.last, team: q.team, pos: q.pos, goalie: q.pos === 'G' }, { strict: true }); if (!m) continue;
  if (fx2nid[m.id] == null) fx2nid[m.id] = q.nid; else if (fx2nid[m.id] !== q.nid) clash.add(m.id);
}
for (const fx of clash) if (!rostered.has(fx)) delete fx2nid[fx];   // a rostered player keeps his roster/prospect match
// Last resort for rostered players still without an id (undrafted signings, older picks): the NHL's player search,
// accepted only when exactly one player has his full name and position group
let searchOk = true;
for (const fx of rostered) {
  if (!searchOk) break;
  if (fx2nid[fx] != null || !ids[fx]) continue;
  const [f, l] = fxSplit(ids[fx].name); const isG = /G/.test(ids[fx].position || '');
  const res = await getJSONr(`https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=20&q=${encodeURIComponent(f + ' ' + l)}`).catch(e => { searchOk = false; notes.push(`search unavailable (${e.message}): skipped`); return null; });
  const hits = (Array.isArray(res) ? res : []).filter(x => nameKey(...String(x.name || '').split(/ (.*)/s).slice(0, 2)) === nameKey(f, l) && (x.positionCode === 'G') === isG);
  const onTeam = hits.filter(x => x.teamAbbrev === ids[fx].team || x.lastTeamAbbrev === ids[fx].team);
  const pick = hits.length === 1 ? hits[0] : onTeam.length === 1 ? onTeam[0] : null;
  if (pick) fx2nid[fx] = +pick.playerId;
}
const want = Object.keys(fx2nid).filter(fx => rostered.has(fx) || (free.has(fx) && (recentGp[fx2nid[fx]] || 0) > 0));

// 4. NHL team names -> codes (past names too)
const tri = {};
for (const t of (await getJSONr('https://api.nhle.com/stats/rest/en/team')).data || []) tri[fold(t.fullName)] = t.triCode;
Object.assign(tri, { [fold('Utah Mammoth')]: 'UTA', [fold('Mighty Ducks of Anaheim')]: 'ANA', [fold('Montreal Canadiens')]: 'MTL' });
const teamOf = (lg, r) => lg === 'NHL' ? (tri[fold(r.teamName?.default)] || r.teamCommonName?.default || r.teamName?.default || '') : (r.teamName?.default || '');

// 5. Season-by-season from each player's NHL page, eight at a time
const land = {}; const bad = [];
let i = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (i < want.length) {
    const fx = want[i++]; const nid = fx2nid[fx];
    try {
      const d = await nhl(`player/${nid}/landing`);
      const [f, l] = fxSplit(ids[fx]?.name);
      // the NHL's name for this id has to agree with Fantrax's (same last name)
      if (fold(d.lastName?.default).replace(/ /g, '') !== fold(l).replace(/ /g, '')) { bad.push(`${f} ${l} -> ${d.firstName?.default} ${d.lastName?.default}`); continue; }
      land[fx] = d;
    } catch (e) { bad.push(`${fx} ${nid}: ${e.message}`); }
  }
}));

// 6. Hits and blocked shots per NHL season (the player pages do not carry them)
const nhlYears = new Set();
for (const d of Object.values(land)) for (const r of d.seasonTotals || []) if (r.leagueAbbrev === 'NHL' && r.gameTypeId === 2) { const y = Math.floor(r.season / 10000); if (y >= 2005 && y < NOW) nhlYears.add(y); }
const hb = {};
for (const y of [...nhlYears].sort()) hb[y] = byPlayer(await report('skater/realtime', `${y}${y + 1}`), r => ({ hit: r.hits || 0, blk: r.blockedShots || 0 }));

// 7. Rows
const out = Array.from({ length: CHUNKS }, (_, k) => ({ at: new Date().toISOString(), through: `${NOW - 1}-${String(NOW).slice(2)}`, chunk: k, of: CHUNKS,
  cols: { sk: ['year', 'league', 'team', 'gp', 'g', 'a', 'pm', 'pim', 'sog', 'ppp', 'shg', 'gwg', 'hit', 'blk', 'toi'], g: ['year', 'league', 'team', 'gp', 'gs', 'w', 'l', 'otl', 'ga', 'sa', 'so', 'toi'] }, p: {} }));
const nz = v => (v == null ? null : v);
let nRows = 0;
for (const [fx, d] of Object.entries(land)) {
  const goalie = d.position === 'G';
  const merged = new Map(); // "year|league" -> row being built
  for (const r of d.seasonTotals || []) {
    if (r.gameTypeId !== 2) continue;
    const y = Math.floor(r.season / 10000), lg = r.leagueAbbrev || '';
    if (y >= NOW) continue;
    if (lg !== 'NHL' && (y < FROM_OTHER || YOUTH.test(lg))) continue;
    const key = y + '|' + lg; const t = teamOf(lg, r);
    let o = merged.get(key);
    if (!o) { o = { y, lg, teams: [], gp: 0, toiSum: 0, toiN: 0 }; merged.set(key, o); }
    if (t && !o.teams.includes(t)) o.teams.push(t);
    const gp = r.gamesPlayed || 0; o.gp += gp;
    const add = (k, v) => { if (v != null) o[k] = (o[k] || 0) + v; };
    if (goalie) {
      add('gs', r.gamesStarted); add('w', r.wins); add('l', r.losses); add('otl', r.otLosses ?? r.ties); add('ga', r.goalsAgainst); add('sa', r.shotsAgainst); add('so', r.shutouts);
      if (r.timeOnIce) add('toiT', sec(r.timeOnIce));
    } else {
      add('g', r.goals); add('a', r.assists); add('pm', r.plusMinus); add('pim', r.pim); add('sog', r.shots); add('ppp', r.powerPlayPoints); add('shg', r.shorthandedGoals); add('gwg', r.gameWinningGoals);
      if (r.avgToi && gp) { o.toiSum += sec(r.avgToi) * gp; o.toiN += gp; }
    }
  }
  const rows = [...merged.values()].sort((a, b) => b.y - a.y || (a.lg === 'NHL' ? -1 : b.lg === 'NHL' ? 1 : 0)).map(o => {
    const team = o.teams.join('/');
    if (goalie) return [o.y, o.lg, team, o.gp, nz(o.gs), nz(o.w), nz(o.l), nz(o.otl), nz(o.ga), nz(o.sa), nz(o.so), o.toiT != null ? Math.round(o.toiT) : null];
    const h = o.lg === 'NHL' ? hb[o.y]?.[d.playerId] : null;
    return [o.y, o.lg, team, o.gp, nz(o.g), nz(o.a), nz(o.pm), nz(o.pim), nz(o.sog), nz(o.ppp), nz(o.shg), nz(o.gwg), h ? h.hit : null, h ? h.blk : null, o.toiN ? Math.round(o.toiSum / o.toiN) : null];
  });
  if (!rows.length) continue;
  nRows += rows.length;
  out[chunkOf(fx)].p[fx] = { nid: d.playerId, n: `${d.firstName?.default || ''} ${d.lastName?.default || ''}`.trim(), ...(goalie ? { g: 1 } : {}), r: rows };
}
const sizes = out.map((c, k) => { writeJSON(careersPath(k), c); return JSON.stringify(c).length; });
console.log(`players ${want.length} wanted, ${Object.keys(land).length} fetched, ${out.reduce((s, c) => s + Object.keys(c.p).length, 0)} with rows, ${nRows} rows | NHL seasons with hits/blocks: ${nhlYears.size} | not matched to NHL: ${[...rostered].filter(fx => fx2nid[fx] == null).length} rostered (no NHL id: unsigned juniors, Europe, camp invites) | name check failed: ${bad.length} | bytes per file: ${sizes.join(' ')}`);
if (bad.length) console.log('name check / fetch failures:', bad.slice(0, 40).join('; '));
if (notes.length) console.log('notes:', notes.join('; '));
console.log('rostered without an NHL id:', [...rostered].filter(fx => !land[fx]).map(fx => ids[fx] ? ids[fx].name : fx).slice(0, 60).join('; '));
const biggest = Math.max(...sizes); if (biggest > 230000) throw new Error(`careers file too big for the board (${biggest} bytes): raise CHUNKS in src/lib/fostats.js and in the page`);
