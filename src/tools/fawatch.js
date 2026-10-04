// Minors free-agent watch: every league's skaters and goalies who hold NHL rights, are 24 or younger, and are a free
// agent or on waivers in our league per Fantrax's own status (getLeagueInfo). Counts players from game 1 (the daily
// scan waits for 3) and ranks across leagues by gem score. Writes data/adhoc/fawatch.json.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadEngine } from '../env.js';
import * as L from '../leagues.js';

const LG = 'fs61ldkdmow7aw2h';
const WS = loadEngine();
Object.assign(WS.NHLE, { ECHL: .15, SHL: .566, Allsvenskan: .297, J20: .09, NCAA: .194, VHL: .30, MHL: .12, Czech: .418 });
if (!WS.HT.ECHL) WS.HT.ECHL = ['echl', '2c2b89ea7345cae8'];
const j = u => fetch(u).then(r => { if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); });
const pinfo = (await j(`https://www.fantrax.com/fxea/general/getLeagueInfo?leagueId=${LG}`)).playerInfo || {};

let fx0 = null;
const pickName = async rows => { fx0 = fx0 || await WS.fantrax(); for (const r of rows) { if (!r.alts) continue; for (const [f, l] of r.alts) { const c = fx0.pool[WS.key(f, l)]; if (c && c.some(x => /G/.test(x[2]) === !!r.goalie)) { r.first = f; r.last = l; break; } } delete r.alts; } return rows; };
const jobs = [
  ...['AHL', 'ECHL', 'OHL', 'WHL', 'QMJHL', 'USHL'].map(lg => [lg, () => WS.hockeytech(lg)()]),
  ['Liiga', () => WS.liiga()()], ['KHL', () => L.khl(WS)],
  ['VHL', async () => pickName(await L.vhl())], ['MHL', async () => pickName(await L.mhl())],
  ['SHL', () => L.shl()], ['Allsvenskan', () => L.swe('Allsvenskan')], ['J20', () => L.swe('J20')],
  ['NCAA', () => L.ncaa(WS.ls)], ['Czech', () => L.czech()], ['NHL', () => WS.nhl()()],
];
const SK = ['fx', 'own', 'st', 'name', 'team', 'pos', 'age', 'gp', 'g', 'a', 'pts', 'ppp', 'ppg', 'nhle', 'prev', 'yoy', 'tr', 'rgp', 'toi'];
const GC = ['fx', 'own', 'st', 'name', 'team', 'age', 'gp', 'svp', 'gaa', 'w', 'min'];
const obj = (cols, s) => Object.fromEntries(s.split('|').map((v, i) => [cols[i], v === '' ? null : isNaN(v) ? v : +v]));
const out = { at: new Date().toISOString(), status: {}, skaters: [], goalies: [] };
for (const [lg, fn] of jobs) {
  try {
    const r = await WS.run(lg, fn, { minGP: 1, maxAge: 24, nAvail: 80 });
    for (const s of r.avail) {
      const o = obj(SK, s); const st = pinfo[o.fx]?.status;
      if (st !== 'FA' && st !== 'WW') continue;
      const af = Math.max(.6, Math.min(1.4, 1 + .1 * (21 - (o.age ?? 21))));
      out.skaters.push({ lg, ...o, fxStatus: st, elig: pinfo[o.fx]?.eligiblePos, gem: +(o.nhle * af * (/D/.test(o.pos) ? 1.3 : 1)).toFixed(1) });
    }
    for (const s of r.goalies) { const o = obj(GC, s); if (o.own) continue; const st = pinfo[o.fx]?.status; if (st === 'FA' || st === 'WW') out.goalies.push({ lg, ...o, fxStatus: st }); }
    out.status[lg] = r.nSk + r.nG ? 'ok' : 'no games yet';
  } catch (e) { out.status[lg] = 'ERR ' + e.message.slice(0, 120); }
}
out.skaters.sort((a, b) => b.gem - a.gem);
const dir = path.join(ROOT, 'data', 'adhoc'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'fawatch.json'), JSON.stringify(out));
console.log(out.status, out.skaters.length, 'skaters', out.goalies.length, 'goalies');
