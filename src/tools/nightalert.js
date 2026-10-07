// Late-night free-agent alert. Scores the night's finished NHL games with league scoring, keeps players Fantrax itself
// shows as free agents (FA) or on waivers (WW) in The Hockey Life, and flags those whose big night came with a usage signal.
//
//   node src/tools/nightalert.js [YYYY-MM-DD]        writes data/adhoc/alert.json  (run around 11:40 PM ET; games still
//                                                    in progress are listed under gamesPending)
//   node src/tools/nightalert.js late [YYYY-MM-DD]   the late pass, for yesterday by default: writes
//                                                    data/adhoc/alert-late.json with candidates only from the games that
//                                                    alert.json listed as pending (all games if alert.json is for another
//                                                    date). Never touches alert.json.
// The date and the late switch can also come from env DATE / LATE=1 / ARGS.
//
// Rules:
//   big night   skater 6+ FP, or goalie win worth 10+ FP
//   usage       forward 16:00+ (D 20:00+), or a power-play point, or 3:00+ above his own season average
//               (the average only counts once he has 3 earlier games; with fewer, `why` says "average of N games")
//   goalie      2+ starts within his team's last three games
//   who         25 or younger with a big night and any usage signal, or any age with a clear role change
//               (3:00+ above his average AND 16:00+ for F / 20:00+ for D; or the goalie test)
import { torontoDate, torontoHour, addDays, isDate, cliArgs, readJSON, writeJSON } from '../lib/config.js';
import { getLeagueInfo, getPlayerIds } from '../lib/fantrax.js';
import { nhl, gamesOn, gameRows, gameLabel, isFinal, isRegularSeasonId, sec, mmss, ageFrom } from '../lib/nhl.js';
import { makeMatcher } from '../lib/names.js';

const args = cliArgs();
const late = args.includes('late') || /^(1|true|yes)$/i.test(process.env.LATE || '');
// "tonight": before 6 AM Toronto it is still last night. The late pass is always about yesterday.
const tonight = torontoHour() < 6 ? addDays(torontoDate(), -1) : torontoDate();
const date = [process.env.DATE, ...args].find(isDate) || (late ? addDays(torontoDate(), -1) : tonight);

const { all, final: done, pending } = await gamesOn(date);
let games = done, lateGames = null;
if (late) {
  const first = readJSON('data/adhoc/alert.json');
  lateGames = first && first.date === date ? (first.gamesPending || []) : all.map(gameLabel);
  games = done.filter(g => lateGames.includes(gameLabel(g)));
}

// Fantrax: player pool (names, NHL club) and each player's status in our league
const ids = await getPlayerIds();
const info = await getLeagueInfo();
if (!info.playerInfo) throw new Error('getLeagueInfo has no playerInfo: free-agent status unknown, no alert written');
const status = id => info.playerInfo[id]?.status || '';
const M = makeMatcher(ids);

const rows = [];
for (const g of games) for (const r of await gameRows(g.id)) rows.push(r);

// keep free agents with a big night, then check usage against each player's own season
const out = [], near = [], unmatched = [];
for (const r of rows) {
  if (r.goalie ? !(r.dec === 'W' && r.fp >= 10) : r.fp < 6) continue;
  let pl;
  try { pl = await nhl(`player/${r.pid}/landing`); } catch (e) { unmatched.push(`${r.name} ${r.team} (no NHL profile)`); continue; }
  const first = pl.firstName?.default || '', last = pl.lastName?.default || r.name;
  r.full = `${first} ${last}`.trim(); r.age = ageFrom(pl.birthDate);
  // full name first, then last name + NHL team (Tommy / Thomas, Mitch / Mitchell)
  const m = M.find({ first, last, team: r.team, pos: r.pos, goalie: r.goalie });
  if (!m) { unmatched.push(`${r.full} ${r.team}`); continue; }
  const fx = m.id, st = status(fx);
  if (!['FA', 'WW'].includes(st)) continue;
  const reasons = []; let roleChange = false, thin = null;
  const log = await nhl(`player/${r.pid}/game-log/now`).then(j => (j.gameLog || []).filter(x => isRegularSeasonId(x.gameId))).catch(() => null);
  if (!r.goalie) {
    const prior = (log || []).filter(x => x.gameDate < date); const toi = sec(r.toi), d = r.pos === 'D';
    const avg = prior.length ? prior.reduce((s, x) => s + sec(x.toi), 0) / prior.length : null;
    const high = toi >= (d ? 1200 : 960);
    if (high) reasons.push(`${mmss(toi)} TOI`);
    if (r.ppp) reasons.push('power-play point');
    const over = avg != null && toi - avg >= 180;
    // an "average" of one or two games proves nothing: it only counts from three earlier games on
    if (over && prior.length >= 3) { reasons.push(`+${mmss(toi - avg)} over his ${mmss(avg)} average`); roleChange = high; }
    else if (over) thin = prior.length;
    r.avgToi = avg != null ? mmss(avg) : null; r.toiTxt = mmss(toi); r.gpBefore = log ? prior.length : null;
    r.line = `${r.g}G ${r.a}A${r.ppp ? ', ' + r.ppp + ' PPP' : ''}, ${r.sog} SOG, ${r.hit} hits, ${r.blk} blk`;
  } else {
    // starts within his team's last three regular-season games (tonight included)
    r.gpBefore = log ? log.filter(x => x.gameDate < date).length : null;
    r.line = `${r.dec || '-'}, ${r.sv} saves on ${r.sa ?? '?'}${r.so ? ', shutout' : ''}`;
    try {
      const sched = await nhl(`club-schedule-season/${r.team}/now`);
      const last3 = (sched.games || []).filter(g => g.gameType === 2 && g.gameDate <= date && (isFinal(g) || g.gameDate < date)).slice(-3).map(g => g.id);
      const started = new Set((log || []).filter(x => x.gamesStarted).map(x => x.gameId));
      const tonightId = games.find(g => [g.awayTeam.abbrev, g.homeTeam.abbrev].includes(r.team))?.id;
      if (r.starter && tonightId) started.add(tonightId);
      const starts = last3.filter(id => started.has(id)).length;
      if (last3.length >= 3 && starts >= 2) { reasons.push(`${starts} starts in his team's last 3 games`); roleChange = true; }
    } catch (e) { }
  }
  const young = r.age != null && r.age <= 25;
  if (!reasons.length || (!young && !roleChange)) { near.push(`${r.full} (${r.team}, ${r.age ?? '?'}): ${r.fp} FP, ${reasons.join(', ') || 'no usage signal'}${r.toiTxt && !reasons.some(x => x.endsWith(' TOI')) ? ', ' + r.toiTxt + ' TOI' : ''}`); continue; }
  out.push({ name: r.full, team: r.team, pos: r.pos, age: r.age, fx, status: st, fp: r.fp, line: r.line, toi: r.toiTxt || null, avgToi: r.avgToi || null, gpBefore: r.gpBefore,
    reasons, why: (young ? (roleChange ? 'young + role change' : 'young + usage') : 'role change') + (thin != null ? ` (TOI is above his average of ${thin} game${thin === 1 ? '' : 's'}, too few to count)` : '') });
}
out.sort((a, b) => (b.why.includes('role') - a.why.includes('role')) || b.fp - a.fp);
const res = { at: new Date().toISOString(), date, ...(late ? { late: true, lateGames } : {}), gamesFinal: games.length, gamesPending: (late ? pending.filter(g => lateGames.includes(gameLabel(g))) : pending).map(gameLabel),
  candidates: out.slice(0, 5), nearMisses: near.slice(0, 10), unmatched };
writeJSON(late ? 'data/adhoc/alert-late.json' : 'data/adhoc/alert.json', res, 1);
console.log(date, late ? 'LATE pass' : '', 'final', games.length, 'pending', res.gamesPending.length, 'candidates', out.length, out.map(c => c.name).join(', '), unmatched.length ? '| unmatched: ' + unmatched.join(', ') : '');
