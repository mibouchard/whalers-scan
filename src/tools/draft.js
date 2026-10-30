// NHL draft record (year, round, overall pick, drafting club) for every player the Front Office player card can show, so
// the card's banner carries a draft chip ("2024 · R4 #125") beside the status chip, and "Undrafted" only where the NHL's
// own record says so. Built every morning after the draftee pool; cheap after the first run because draft records never
// change (state/ws.draft.json keeps every answer by NHL id).
//
// Who: every player on a roster in our league (this period and next), every free agent in the free-agent watch and the
// draftee pool, and every player the careers files already map to an NHL id.
// Sources, in order (all public):
//   1. data/adhoc/draftees.json: free draftees of the last four drafts, already matched to Fantrax ids (verified)
//   2. the player's NHL page (api-web.nhle.com player/<nid>/landing, draftDetails) for every Fantrax id with an NHL id
//      (careers files, box files, the draftee id map); a page with no draftDetails is a verified undrafted player
//   3. for rostered players with no NHL id: the NHL's pick lists (draft/picks/<year>/all, 2008 on) matched by name
//      and position group, strictly (one candidate, or the one on the drafting club); a miss stays unknown, never "undrafted"
//
// Writes data/fo/draft.json (the morning report copies it to the dashboard as snapshot/draft):
//   { at, d, n, cols: ['year', 'round', 'pick', 'team'], p: { <fantraxId>: [year, round, overall, club] },
//     u: [<fantraxId>, ...] (verified undrafted), how: { draftees, page, picks }, unknown: <count>, notes: [...] }
// Run alone:  node src/tools/draft.js            (ARGS=recheck re-reads every undrafted player's page)
import { torontoDate, readJSON, writeJSON } from '../lib/config.js';
import { getPlayerIds } from '../lib/fantrax.js';
import { nhl, seasonId } from '../lib/nhl.js';
import { getJSONr } from '../lib/util.js';
import { makeMatcher, fxSplit, fxGroup, posGroup, fold } from '../lib/names.js';
import { careersNid, boxNid } from '../lib/fostats.js';

const t0 = Date.now();
const UA = { headers: { 'User-Agent': 'curl/8.5.0' } };
const RECHECK = /\brecheck\b/.test(process.env.ARGS || '');
const NOW = +seasonId().slice(0, 4);               // season's first year: 2026 for 2026-27
const notes = [];

const ids = await getPlayerIds();
const L = readJSON('data/league.json');
if (!L?.teams) throw new Error('data/league.json has no rosters: run the league tool first');

// 1. Who
const want = new Set();
for (const t of Object.values(L.teams)) for (const x of [t.cur, t.next]) for (const r of x || []) want.add(r[0]);
const nRostered = want.size;
const FW = readJSON('data/adhoc/fawatch.json') || {};
for (const r of [...(FW.skaters || []), ...(FW.goalies || [])]) if (r.fx) want.add(r.fx);
const DR = readJSON('data/adhoc/draftees.json') || {};
for (const r of DR.rows || []) if (r.fx) want.add(r.fx);

// 2. Fantrax id -> NHL id
const fx2nid = { ...careersNid(), ...boxNid() };
for (const r of DR.rows || []) if (r.fx && r.nid) fx2nid[r.fx] = r.nid;
for (const fx of Object.keys(fx2nid)) want.add(fx);

// 3. Permanent cache by NHL id: { nid: [year, round, pick, club] } or { nid: 0 } for undrafted (with the season it was checked)
const cache = readJSON('state/ws.draft.json') || { v: 1, p: {}, u: {} };
const out = { at: new Date().toISOString(), d: torontoDate(), n: 0, cols: ['year', 'round', 'pick', 'team'], p: {}, u: [], how: { draftees: 0, page: 0, picks: 0 }, unknown: 0, notes };

// 3a. the draftee pool first: verified picks, no fetch
for (const r of DR.rows || []) if (r.fx && r.y && r.pk && !out.p[r.fx]) { out.p[r.fx] = [r.y, r.rd, r.pk, r.tm || '']; out.how.draftees++; if (r.nid) cache.p[r.nid] = out.p[r.fx]; }

// 3b. NHL pages for ids not yet known (eight at a time); an undrafted answer is re-read once a season for anyone
//     still young enough to be picked (a 2008-born can go in June 2027), or on ARGS=recheck
const todo = [...want].filter(fx => !out.p[fx] && fx2nid[fx] != null).filter(fx => {
  const nid = fx2nid[fx]; if (cache.p[nid]) return false;
  const u = cache.u[nid]; if (u == null) return true;
  return RECHECK || (u.at < NOW && (u.age == null || u.age < 21));
});
let i = 0; const bad = [];
await Promise.all(Array.from({ length: 8 }, async () => {
  while (i < todo.length) {
    const fx = todo[i++]; const nid = fx2nid[fx];
    try {
      const d = await nhl(`player/${nid}/landing`);
      const [, l] = fxSplit(ids[fx]?.name);
      if (ids[fx] && fold(d.lastName?.default).replace(/ /g, '') !== fold(l).replace(/ /g, '')) { bad.push(`${fx} ${nid}: NHL page is ${d.firstName?.default} ${d.lastName?.default}, Fantrax ${ids[fx].name}`); continue; }
      const dd = d.draftDetails;
      if (dd && dd.year && dd.overallPick) cache.p[nid] = [+dd.year, +dd.round || Math.ceil(dd.overallPick / 32), +dd.overallPick, dd.teamAbbrev || ''];
      else { const age = d.birthDate ? Math.floor((Date.now() - new Date(d.birthDate)) / 31557600000) : null; cache.u[nid] = { at: NOW, age }; }
    } catch (e) { bad.push(`${fx} ${nid}: ${e.message}`); }
  }
}));
if (bad.length) notes.push(`${bad.length} NHL page(s) skipped: ${bad.slice(0, 8).join('; ')}${bad.length > 8 ? '; ...' : ''}`);
for (const fx of want) {
  if (out.p[fx]) continue;
  const nid = fx2nid[fx]; if (nid == null) continue;
  if (cache.p[nid]) { out.p[fx] = cache.p[nid]; out.how.page++; }
  else if (cache.u[nid]) out.u.push(fx);
}

// 3c. rostered players with no NHL id: the pick lists, by name, strictly (a namesake with no club match is left unknown)
const noId = [...want].filter(fx => !out.p[fx] && !out.u.includes(fx) && fx2nid[fx] == null && ids[fx]);
if (noId.length) {
  const sub = {}; for (const fx of noId) sub[fx] = ids[fx];
  const M = makeMatcher(sub);
  const FROM = Math.max(2008, NOW - 18);
  for (let y = FROM; y <= NOW; y++) {
    const j = await getJSONr(`https://api-web.nhle.com/v1/draft/picks/${y}/all`, UA).catch(e => { notes.push(`picks ${y}: ${e.message}`); return null; });
    for (const p of j?.picks || []) {
      if (!p.firstName?.default) continue;
      const m = M.find({ first: p.firstName.default, last: p.lastName.default, team: p.teamAbbrev, pos: p.positionCode, goalie: p.positionCode === 'G' }, { strict: true });
      if (!m || out.p[m.id]) continue;
      // the position group has to agree when Fantrax has one
      const g = fxGroup(ids[m.id].position); if (g && posGroup(p.positionCode) && g !== posGroup(p.positionCode)) continue;
      out.p[m.id] = [y, p.round, p.overallPick, p.teamAbbrev || '']; out.how.picks++;
    }
  }
}

out.n = Object.keys(out.p).length;
out.unknown = [...want].filter(fx => !out.p[fx] && !out.u.includes(fx)).length;
out.u.sort();
writeJSON('state/ws.draft.json', cache);
const f = writeJSON('data/fo/draft.json', out);
console.log(`draft: ${want.size} players (${nRostered} rostered) | ${out.n} drafted (${out.how.draftees} draftee pool, ${out.how.page} NHL page, ${out.how.picks} pick lists) | ${out.u.length} undrafted | ${out.unknown} unknown (no NHL id, no pick match) | ${todo.length} pages read | ${Math.round((Date.now() - t0) / 1000)}s -> ${f}`);
