// Look up players by name: Fantrax id, NHL team (rights), position, our-league status (FA / WW / T) and, if owned,
// which fantasy team and roster slot (next period). Reads data/adhoc/names-in.json (array of "First Last"), writes
// data/adhoc/names.json.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env.js';
const L = 'fs61ldkdmow7aw2h';
const TEAMS = { "m1hfr04lmow7aw2v": "HFD", "4psrznwkmow7aw2u": "CGY", "h32ctyahmow7aw2v": "BOS", "svnb4s7amow7aw2u": "CGS", "fay1fny2mow7aw2u": "VAN", "nw53mrdzmow7aw2v": "QUE", "ps4l4b6mmow7aw2v": "WPG", "39n75kyjmow7aw2u": "CHI", "tu2c5havmow7aw2v": "WAS", "tsr78hmdmow7aw2u": "ANA", "nx9xgs2mmow7aw2u": "COL", "br7rvnwsmow7aw2u": "OTT", "z64j08mgmow7aw2u": "MTL", "vm1rdwvtmow7aw2u": "CAR", "hghiywi2mow7aw2u": "EDM", "4yx4ssw6mow7aw2v": "DET" };
const j = u => fetch(u).then(r => r.json());
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/gi, '').toLowerCase();
const want = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'adhoc', 'names-in.json'), 'utf8'));
const ids = await j('https://www.fantrax.com/fxea/general/getPlayerIds?sport=NHL');
const pi = (await j(`https://www.fantrax.com/fxea/general/getLeagueInfo?leagueId=${L}`)).playerInfo || {};
const cur = await j(`https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${L}`);
const nxt = await j(`https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${L}&period=${cur.period + 1}`).catch(() => cur);
const own = {}; for (const [tid, t] of Object.entries(nxt.rosters)) for (const i of t.rosterItems) own[i.id] = (TEAMS[tid] || tid) + ':' + i.status;
const byFull = {}, byLast = {};
for (const [id, p] of Object.entries(ids)) { const [l, f] = (p.name || '').split(', '); (byFull[norm(f) + '|' + norm(l)] ||= []).push(id); (byLast[norm(l)] ||= []).push(id); }
const out = {};
for (const n of want) {
  const parts = n.split(' '); const f = parts[0], l = parts.slice(1).join(' ');
  const hits = byFull[norm(f) + '|' + norm(l)] || (byLast[norm(l)] || []).filter(id => norm((ids[id].name || '').split(', ')[1] || '').startsWith(norm(f).slice(0, 3)));
  out[n] = hits.map(id => ({ id, name: ids[id].name, team: ids[id].team, pos: ids[id].position, status: pi[id]?.status || null, owner: own[id] || null }));
}
fs.writeFileSync(path.join(ROOT, 'data', 'adhoc', 'names.json'), JSON.stringify(out, null, 1));
console.log(Object.values(out).filter(v => !v.length).length, 'not found');
