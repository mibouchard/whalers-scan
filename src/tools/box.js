// Last night's NHL games scored with league rules, tagged with the fantasy owner and status from the roster in effect
// when the games were played (current period), plus next period's owner so this week's claims show.
// Usage: node src/tools/box.js [YYYY-MM-DD]   (default: yesterday, Toronto time). Writes data/adhoc/box.json and box-<date>.json.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env.js';

const L = 'fs61ldkdmow7aw2h';
const TEAMS = { "m1hfr04lmow7aw2v": "HFD", "4psrznwkmow7aw2u": "CGY", "h32ctyahmow7aw2v": "BOS", "svnb4s7amow7aw2u": "CGS", "fay1fny2mow7aw2u": "VAN", "nw53mrdzmow7aw2v": "QUE", "ps4l4b6mmow7aw2v": "WPG", "39n75kyjmow7aw2u": "CHI", "tu2c5havmow7aw2v": "WAS", "tsr78hmdmow7aw2u": "ANA", "nx9xgs2mmow7aw2u": "COL", "br7rvnwsmow7aw2u": "OTT", "z64j08mgmow7aw2u": "MTL", "vm1rdwvtmow7aw2u": "CAR", "hghiywi2mow7aw2u": "EDM", "4yx4ssw6mow7aw2v": "DET" };
const j = u => fetch(u).then(r => { if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); });
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/gi, '').toLowerCase();
const key = (f, l) => [norm(f), norm(l)].sort().join('|');

const tz = d => new Date(d.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
const day = process.argv[2] || (() => { const t = tz(new Date()); t.setDate(t.getDate() - 1); return t.toISOString().slice(0, 10); })();

const score = await j(`https://api-web.nhle.com/v1/score/${day}`);
const games = (score.games || []).filter(g => /FINAL|OFF/.test(g.gameState));

// Fantrax: pool + rosters (current period = in effect for these games; next period for claims made this week)
const ids = await j('https://www.fantrax.com/fxea/general/getPlayerIds?sport=NHL');
const cur = await j(`https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${L}`);
const nxt = await j(`https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${L}&period=${cur.period + 1}`).catch(() => cur);
const own = (ro) => { const m = {}; for (const [tid, t] of Object.entries(ro.rosters)) for (const i of t.rosterItems) m[i.id] = { team: TEAMS[tid] || tid, st: i.status, sal: +(i.salary / 1e6).toFixed(3) }; return m; };
const ownCur = own(cur), ownNxt = own(nxt);
const pool = {}; // name key -> [{id, team, pos}]
for (const [id, p] of Object.entries(ids)) { const [l, f] = (p.name || '').split(', '); (pool[key(f, l)] ||= []).push({ id, team: p.team, pos: p.position }); }

const rows = [];
for (const g of games) {
  const [box, land] = await Promise.all([j(`https://api-web.nhle.com/v1/gamecenter/${g.id}/boxscore`), j(`https://api-web.nhle.com/v1/gamecenter/${g.id}/landing`)]);
  const a = box.awayTeam, h = box.homeTeam;
  const win = a.score > h.score ? a.abbrev : h.abbrev, lose = Math.min(a.score, h.score);
  // full names from both clubs' rosters
  const names = {};
  for (const t of [a.abbrev, h.abbrev]) { const r = await j(`https://api-web.nhle.com/v1/roster/${t}/current`).catch(() => ({})); for (const p of [...(r.forwards || []), ...(r.defensemen || []), ...(r.goalies || [])]) names[p.id] = [p.firstName.default, p.lastName.default]; }
  const ex = {}; const bump = (pid, k) => { (ex[pid] ||= { ppp: 0, shg: 0, gwg: 0 })[k]++; };
  let n = 0;
  for (const per of land.summary?.scoring || []) for (const gl of per.goals || []) {
    if (per.periodDescriptor?.periodType === 'SO') continue;
    const st = (gl.strength || '').toLowerCase();
    if (st === 'pp') { bump(gl.playerId, 'ppp'); (gl.assists || []).forEach(x => bump(x.playerId, 'ppp')); }
    if (st === 'sh') bump(gl.playerId, 'shg');
    if (gl.teamAbbrev?.default === win || gl.teamAbbrev === win) { const s = win === a.abbrev ? gl.awayScore : gl.homeScore; if (s === lose + 1) bump(gl.playerId, 'gwg'); }
  }
  for (const side of ['awayTeam', 'homeTeam']) {
    const t = box[side].abbrev, opp = side === 'awayTeam' ? h.abbrev : a.abbrev, ps = box.playerByGameStats[side];
    const gl = ps.goalies || [];
    for (const p of [...(ps.forwards || []), ...(ps.defense || []), ...gl]) {
      const isG = gl.includes(p); const nm = names[p.playerId] || [null, p.name?.default];
      const e = ex[p.playerId] || { ppp: 0, shg: 0, gwg: 0 };
      let fp, line;
      if (isG) {
        if (!p.toi || p.toi === '00:00') continue;
        const sv = p.saves ?? 0, ga = p.goalsAgainst ?? 0, w = p.decision === 'W' ? 1 : 0;
        const so = w && ga === 0 && gl.filter(x => x.toi && x.toi !== '00:00').length === 1 ? 1 : 0;
        fp = 5 * w + 5 * so + 0.25 * sv - ga + 2 * (p.assists || 0) + 3 * (p.goals || 0);
        line = { dec: p.decision || '', sv, sa: p.shotsAgainst, ga, so, toi: p.toi };
      } else {
        const G = p.goals || 0, A = p.assists || 0;
        fp = 3 * G + 2 * A + e.ppp + 2 * e.shg + e.gwg + 0.5 * (p.plusMinus || 0) + 0.2 * (p.blockedShots || 0) + 0.2 * (p.hits || 0) + 0.25 * (p.pim || 0) + 0.1 * (p.sog || 0);
        line = { g: G, a: A, ppp: e.ppp, shg: e.shg, gwg: e.gwg, pm: p.plusMinus || 0, sog: p.sog || 0, hit: p.hits || 0, blk: p.blockedShots || 0, pim: p.pim || 0, toi: p.toi };
      }
      const cands = (pool[key(nm[0], nm[1])] || []).filter(c => /G/.test(c.pos) === isG);
      const c = cands.find(c => c.team === t) || (cands.length === 1 ? cands[0] : cands.find(c => !c.team || c.team === '(N/A)') || cands[0]);
      const fx = c?.id || null;
      rows.push({ name: (nm[0] ? nm[0] + ' ' : '') + nm[1], team: t, opp, pos: isG ? 'G' : p.position, fp: +fp.toFixed(2), ...line, fx, own: fx && ownCur[fx] ? ownCur[fx].team : null, st: fx && ownCur[fx] ? ownCur[fx].st : null, ownNext: fx && ownNxt[fx] ? ownNxt[fx].team + ':' + ownNxt[fx].st : null, sal: fx && (ownNxt[fx] || ownCur[fx]) ? (ownNxt[fx] || ownCur[fx]).sal : null });
    }
  }
}
rows.sort((x, y) => y.fp - x.fp);
const out = { d: day, at: new Date().toISOString(), period: cur.period, games: games.map(g => `${g.awayTeam.abbrev} ${g.awayTeam.score}-${g.homeTeam.score} ${g.homeTeam.abbrev}${g.gameOutcome?.lastPeriodType && g.gameOutcome.lastPeriodType !== 'REG' ? ' ' + g.gameOutcome.lastPeriodType : ''}`), gameType: [...new Set(games.map(g => g.gameType))], rows };
const dir = path.join(ROOT, 'data', 'adhoc'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'box.json'), JSON.stringify(out));
fs.writeFileSync(path.join(dir, `box-${day}.json`), JSON.stringify(out));
console.log(day, games.length, 'games', rows.length, 'players');
