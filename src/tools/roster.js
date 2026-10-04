// Fred's (HFD) roster for the current and next scoring period, with names, NHL team, position, status and salary,
// plus each player's Fantrax status. Writes data/adhoc/hfd-roster.json.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env.js';

const L = 'fs61ldkdmow7aw2h', HFD = 'm1hfr04lmow7aw2v';
const j = u => fetch(u).then(r => { if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); });
const ids = await j('https://www.fantrax.com/fxea/general/getPlayerIds?sport=NHL');
const cur = await j(`https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${L}`);
const nxt = await j(`https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${L}&period=${cur.period + 1}`).catch(() => cur);
const rows = ro => (ro.rosters[HFD]?.rosterItems || []).map(i => { const p = ids[i.id] || {}; const [l, f] = (p.name || '').split(', '); return { id: i.id, name: f ? f + ' ' + l : (p.name || i.id), nhlTeam: p.team || null, pos: i.position, status: i.status, salary: +(i.salary / 1e6).toFixed(3) }; });
const out = { at: new Date().toISOString(), period: cur.period, current: rows(cur), next: rows(nxt) };
const count = r => r.reduce((m, x) => (m[x.status] = (m[x.status] || 0) + 1, m), {});
out.counts = { current: count(out.current), next: count(out.next) };
const dir = path.join(ROOT, 'data', 'adhoc'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'hfd-roster.json'), JSON.stringify(out, null, 1));
console.log(out.counts);
