// One-off helper: centre options for HFD. Writes data/adhoc/centres.json with
// - HFD's roster for the next scoring period (status, salary, positions) and cap math
// - every Fantrax FA/WW player eligible at C, with NHL season stats from club-stats and league FP/G (no hits/blocks in that feed)
// - games per NHL team for the next two Monday-Sunday weeks
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env.js';

const L = 'fs61ldkdmow7aw2h', HFD = 'm1hfr04lmow7aw2v', CAP = 114.4, DEAD = 0.59;
const j = u => fetch(u).then(r => { if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); });
const ro = await j(`https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${L}`);
const next = await j(`https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${L}&period=${ro.period + 1}`).catch(() => ro);
const [ids, info] = await Promise.all([j('https://www.fantrax.com/fxea/general/getPlayerIds?sport=NHL'), j(`https://www.fantrax.com/fxea/general/getLeagueInfo?leagueId=${L}`)]);
const name = id => (ids[id] || {}).name || id;
const me = next.rosters[HFD].rosterItems.map(i => ({ id: i.id, name: name(i.id), team: (ids[i.id] || {}).team, pos: (info.playerInfo[i.id] || {}).eligiblePos || i.position, status: i.status, salary: i.salary / 1e6 }));
const used = me.filter(p => p.status === 'ACTIVE' || p.status === 'RESERVE').reduce((s, p) => s + p.salary, 0);
const counts = me.reduce((m, p) => (m[p.status] = (m[p.status] || 0) + 1, m), {});

// NHL: per-team skater stats and the next two weeks of games
const T = ['ANA', 'BOS', 'BUF', 'CGY', 'CAR', 'CHI', 'COL', 'CBJ', 'DAL', 'DET', 'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NSH', 'NJD', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT', 'SJS', 'SEA', 'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WSH', 'WPG'];
const monday = (() => { const d = new Date(); d.setUTCHours(12); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7)); return d; })();
const wk = n => { const s = new Date(monday); s.setUTCDate(s.getUTCDate() + 7 * n); const e = new Date(s); e.setUTCDate(e.getUTCDate() + 6); return [s.toISOString().slice(0, 10), e.toISOString().slice(0, 10)]; };
const weeks = [wk(0), wk(1)];
const games = {}, stats = {};
for (let i = 0; i < T.length; i += 4) await Promise.all(T.slice(i, i + 4).map(async t => {
  const [sch, cs] = await Promise.all([j(`https://api-web.nhle.com/v1/club-schedule-season/${t}/20262027`), j(`https://api-web.nhle.com/v1/club-stats/${t}/now`).catch(() => ({}))]);
  games[t] = weeks.map(([s, e]) => sch.games.filter(g => g.gameType === 2 && g.gameDate >= s && g.gameDate <= e).length);
  for (const p of cs.skaters || []) stats[(p.firstName.default + ' ' + p.lastName.default).toLowerCase()] = { team: t, gp: p.gamesPlayed, g: p.goals, a: p.assists, ppg: p.powerPlayGoals, shg: p.shorthandedGoals, gwg: p.gameWinningGoals, pm: p.plusMinus, pim: p.penaltyMinutes, sog: p.shots, toi: p.avgTimeOnIcePerGame };
}));
const fp = s => s && s.gp ? +((3 * s.g + 2 * s.a + 1 * s.ppg + 2 * s.shg + s.gwg + .5 * s.pm + .25 * s.pim + .1 * s.sog) / s.gp).toFixed(2) : null;
const look = id => { const n = name(id); const [last, first] = n.split(', '); return stats[((first || '') + ' ' + last).toLowerCase()]; };

const fa = Object.entries(info.playerInfo).filter(([, v]) => (v.status === 'FA' || v.status === 'WW') && /(^|,)C(,|$)/.test(v.eligiblePos || '')).map(([id, v]) => { const s = look(id); return { id, name: name(id), team: (ids[id] || {}).team, pos: v.eligiblePos, status: v.status, nhl: s || null, fpg: fp(s), toi: s ? +(s.toi / 60).toFixed(1) : null, games: s ? games[s.team] : null }; })
  .filter(p => p.nhl && p.nhl.gp >= 1).sort((a, b) => (b.fpg || 0) - (a.fpg || 0)).slice(0, 40);
const mine = me.filter(p => /(^|,)C(,|$)/.test(p.pos)).map(p => { const s = look(p.id); return { ...p, nhl: s || null, fpg: fp(s), toi: s ? +(s.toi / 60).toFixed(1) : null, games: s ? games[s.team] : (games[p.team] || null) }; });

const out = { at: new Date().toISOString(), period: ro.period + 1, weeks, cap: { cap: CAP, dead: DEAD, used: +used.toFixed(3), room: +(CAP - used - DEAD).toFixed(3) }, counts, roster: me, myCentres: mine, faCentres: fa, games };
fs.mkdirSync(path.join(ROOT, 'data', 'adhoc'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'adhoc', 'centres.json'), JSON.stringify(out, null, 1));
console.log('period', out.period, 'cap', out.cap, counts, 'FA centres', fa.length);
