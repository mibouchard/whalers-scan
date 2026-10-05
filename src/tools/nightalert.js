// Late-night free-agent alert. Scores tonight's finished NHL games with league scoring, keeps players Fantrax shows as free
// agents (FA) or on waivers (WW) in The Hockey Life, and flags those whose big night came with a usage signal.
// Writes data/adhoc/alert.json. Run around 11:40 PM ET; games still in progress are listed as pending and left to the
// morning report.
//
// Rules (Fred, Oct 5 2026):
//   big night   skater 6+ FP, or goalie win worth 10+ FP
//   usage       forward 16:00+ (D 20:00+), or a power-play point, or 3:00+ above his own average this season
//   who         25 or younger with a big night and any usage signal, or any age with a clear role change
//               (3:00+ above his average AND 16:00+ for F / 20:00+ for D)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env.js';

const L = 'fs61ldkdmow7aw2h';
const j = u => fetch(u).then(r => { if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); });
const tz = d => new Date(d.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
const now = tz(new Date());
if (now.getHours() < 6) now.setDate(now.getDate() - 1); // run after midnight: still "tonight"
const date = process.argv[2] || process.env.DATE || now.toISOString().slice(0, 10);
const sec = t => { if (!t) return 0; const [m, s] = String(t).split(':').map(Number); return m * 60 + (s || 0); };
const mmss = s => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['.\-]/g, '').toLowerCase().split(/\s+/).sort().join(' ');

const score = await j(`https://api-web.nhle.com/v1/score/${date}`);
const games = (score.games || []).filter(g => g.gameType === 2);
const done = games.filter(g => ['FINAL', 'OFF'].includes(g.gameState));
const pending = games.filter(g => !['FINAL', 'OFF'].includes(g.gameState)).map(g => g.awayTeam.abbrev + '@' + g.homeTeam.abbrev);

// Fantrax: player pool (names, NHL club) and each player's status in our league
const ids = await j('https://www.fantrax.com/fxea/general/getPlayerIds?sport=NHL');
const fxByKey = {};
for (const [id, p] of Object.entries(ids)) { const [l, f] = (p.name || '').split(', '); fxByKey[(p.team || '') + '|' + norm((f || '') + ' ' + (l || ''))] = id; }
const info = await j(`https://www.fantrax.com/fxea/general/getLeagueInfo?leagueId=${L}`);
const status = id => (info.playerInfo || {})[id]?.status || '';

const rows = [];
for (const g of done) {
  const [box, land] = await Promise.all([j(`https://api-web.nhle.com/v1/gamecenter/${g.id}/boxscore`), j(`https://api-web.nhle.com/v1/gamecenter/${g.id}/landing`)]);
  const away = box.awayTeam.abbrev, home = box.homeTeam.abbrev;
  const fin = { [away]: box.awayTeam.score, [home]: box.homeTeam.score };
  const winner = fin[away] > fin[home] ? away : home, loser = winner === away ? home : away;
  const ppp = {}, shg = {}, gwg = {}; const run = { [away]: 0, [home]: 0 };
  for (const per of land.summary?.scoring || []) {
    if (per.periodDescriptor?.periodType === 'SO') continue;
    for (const gl of per.goals || []) {
      const team = gl.teamAbbrev?.default || gl.teamAbbrev; run[team] = (run[team] || 0) + 1;
      if (gl.strength === 'pp') { ppp[gl.playerId] = (ppp[gl.playerId] || 0) + 1; for (const a of gl.assists || []) ppp[a.playerId] = (ppp[a.playerId] || 0) + 1; }
      if (gl.strength === 'sh') shg[gl.playerId] = (shg[gl.playerId] || 0) + 1;
      if (team === winner && run[team] === fin[loser] + 1) gwg[gl.playerId] = 1;
    }
  }
  for (const [side, team] of [['awayTeam', away], ['homeTeam', home]]) {
    const S = box.playerByGameStats?.[side] || {};
    for (const p of [...(S.forwards || []), ...(S.defense || [])]) {
      const fp = 3 * (p.goals || 0) + 2 * (p.assists || 0) + (ppp[p.playerId] || 0) + 2 * (shg[p.playerId] || 0) + (gwg[p.playerId] || 0)
        + 0.5 * (p.plusMinus || 0) + 0.25 * (p.pim || 0) + 0.1 * (p.sog || 0) + 0.2 * (p.hits || 0) + 0.2 * (p.blockedShots || 0);
      rows.push({ pid: p.playerId, name: p.name?.default, team, pos: p.position, d: p.position === 'D', fp: +fp.toFixed(2), toi: sec(p.toi), ppp: ppp[p.playerId] || 0,
        line: `${p.goals || 0}G ${p.assists || 0}A${ppp[p.playerId] ? ', ' + ppp[p.playerId] + ' PPP' : ''}, ${p.sog || 0} SOG, ${p.hits || 0} hits, ${p.blockedShots || 0} blk` });
    }
    for (const p of S.goalies || []) {
      if (!p.starter && !p.decision) continue;
      const [sv, sa] = String(p.saveShotsAgainst || '0/0').split('/').map(Number);
      const so = p.decision === 'W' && (p.goalsAgainst || 0) === 0;
      const fp = (p.decision === 'W' ? 5 : 0) + (so ? 5 : 0) + 0.25 * sv - (p.goalsAgainst || 0);
      rows.push({ pid: p.playerId, name: p.name?.default, team, pos: 'G', goalie: true, fp: +fp.toFixed(2), win: p.decision === 'W', line: `${p.decision || '-'}, ${sv} saves on ${sa}` });
    }
  }
}

// keep free agents with a big night, then check usage against each player's own season
const out = [], near = [];
for (const r of rows) {
  if (r.goalie ? !(r.win && r.fp >= 10) : r.fp < 6) continue;
  let fx = null;
  try {
    const pl = await j(`https://api-web.nhle.com/v1/player/${r.pid}/landing`);
    r.full = `${pl.firstName?.default} ${pl.lastName?.default}`;
    r.age = pl.birthDate ? Math.floor((Date.now() - Date.parse(pl.birthDate)) / 31557600000) : null;
    fx = fxByKey[r.team + '|' + norm(r.full)] || fxByKey['|' + norm(r.full)] || null;
  } catch (e) { continue; }
  const st = fx ? status(fx) : '';
  if (!fx || !['FA', 'WW'].includes(st)) continue;
  const reasons = [];
  let roleChange = false;
  if (!r.goalie) {
    let prior = [];
    try { prior = ((await j(`https://api-web.nhle.com/v1/player/${r.pid}/game-log/now`)).gameLog || []).filter(x => String(x.gameId).slice(4, 6) === '02' && x.gameDate < date); } catch (e) { }
    const avg = prior.length ? prior.reduce((s, x) => s + sec(x.toi), 0) / prior.length : null;
    const high = r.toi >= (r.d ? 1200 : 960);
    if (high) reasons.push(`${mmss(r.toi)} TOI`);
    if (r.ppp) reasons.push('power-play point');
    if (avg != null && r.toi - avg >= 180) reasons.push(`+${mmss(r.toi - avg)} over his ${mmss(avg)} average`);
    roleChange = avg != null && r.toi - avg >= 180 && high;
    r.avgToi = avg != null ? mmss(avg) : null; r.toiTxt = mmss(r.toi); r.gpBefore = prior.length;
  } else {
    let starts = 0;
    try { const lg = ((await j(`https://api-web.nhle.com/v1/player/${r.pid}/game-log/now`)).gameLog || []).filter(x => String(x.gameId).slice(4, 6) === '02'); starts = lg.filter(x => x.gamesStarted).slice(0, 3).length; r.gpBefore = lg.length; } catch (e) { }
    if (starts >= 2) { reasons.push(`${starts} starts in his last 3 games`); roleChange = true; }
  }
  const young = r.age != null && r.age <= 25;
  if (!reasons.length || (!young && !roleChange)) { near.push(`${r.full || r.name} (${r.team}, ${r.age ?? '?'}): ${r.fp} FP, ${reasons.join(', ') || 'no usage signal'}${r.toiTxt ? ', ' + r.toiTxt + ' TOI' : ''}`); continue; }
  out.push({ name: r.full || r.name, team: r.team, pos: r.pos, age: r.age, fx, status: st, fp: r.fp, line: r.line, toi: r.toiTxt || null, avgToi: r.avgToi || null,
    reasons, why: young ? (roleChange ? 'young + role change' : 'young + usage') : 'role change' });
}
out.sort((a, b) => (b.why.includes('role') - a.why.includes('role')) || b.fp - a.fp);
const res = { at: new Date().toISOString(), date, gamesFinal: done.length, gamesPending: pending, candidates: out.slice(0, 5), nearMisses: near.slice(0, 10) };
const dir = path.join(ROOT, 'data', 'adhoc'); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'alert.json'), JSON.stringify(res, null, 1));
console.log(date, 'final', done.length, 'pending', pending.length, 'candidates', out.length, out.map(c => c.name).join(', '));
