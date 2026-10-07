// Look up players by name: Fantrax id, NHL team (rights), position, our-league status (FA / WW / T) and, if owned,
// which fantasy team and roster slot (next period). Reads data/adhoc/names-in.json (array of "First Last"), writes
// data/adhoc/names.json: { at, "<First Last>": [{ id, name, team, pos, status, owner }], ... }.
import { readJSON, writeJSON } from '../lib/config.js';
import { getLeagueInfo, getPlayerIds, rosterBundle, ownership } from '../lib/fantrax.js';
import { fold, nameKey, fxSplit } from '../lib/names.js';

const want = readJSON('data/adhoc/names-in.json');
if (!Array.isArray(want)) throw new Error('data/adhoc/names-in.json must be an array of names');
const ids = await getPlayerIds(); // every call checks the HTTP status and retries
const pi = (await getLeagueInfo()).playerInfo || {};
const ro = await rosterBundle();
const own = ownership(ro.own);
const byFull = {}, byLast = {};
for (const [id, p] of Object.entries(ids)) { const [f, l] = fxSplit(p.name); (byFull[nameKey(f, l)] ||= []).push(id); (byLast[fold(l)] ||= []).push(id); }
const out = { at: new Date().toISOString() };
for (const n of want) {
  const i = n.indexOf(' '); const f = i < 0 ? '' : n.slice(0, i), l = i < 0 ? n : n.slice(i + 1);
  // exact name first; otherwise the same last name with a first name that starts the same (Mitch / Mitchell)
  const hits = byFull[nameKey(f, l)] || (byLast[fold(l)] || []).filter(id => fold(fxSplit(ids[id].name)[0]).startsWith(fold(f).slice(0, 3)));
  out[n] = hits.map(id => ({ id, name: ids[id].name, team: ids[id].team, pos: ids[id].position, status: pi[id]?.status || null, owner: own[id] ? own[id].team + ':' + own[id].st : null }));
}
writeJSON('data/adhoc/names.json', out, 1);
console.log(want.filter(n => !out[n].length).length, 'not found', ro.notes.join('; '));
