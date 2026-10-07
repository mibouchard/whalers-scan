// A night of NHL games scored with league rules. Every player is tagged with his fantasy owner and roster status from the
// scoring period in effect when the game was played (periodForDate), with next period's owner (ownNext, so this week's
// claims show) and with Fantrax's own free-agent status (fxStatus: FA, WW or T). Regular-season games only.
// Usage: node src/tools/box.js [YYYY-MM-DD]   (or env DATE / ARGS; default: yesterday, Toronto time)
// Writes data/adhoc/box.json and data/adhoc/box-<date>.json (dated copies are kept 14 days).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, TEAM_ID, MY, torontoDate, addDays, isDate, cliArgs, writeJSON } from '../lib/config.js';
import { getLeagueInfo, getPlayerIds, getRosters, rosterBundle, ownership, capOf, periodForDate } from '../lib/fantrax.js';
import { gamesOn, gameRows, clubRoster, gameLabel } from '../lib/nhl.js';
import { makeMatcher, fxDisplay } from '../lib/names.js';
import { errText } from '../lib/util.js';

const day = [process.env.DATE, ...cliArgs()].find(isDate) || addDays(torontoDate(), -1);
const notes = [];
const { final: games, pending } = await gamesOn(day);

// Fantrax: names, rosters for the current and next period, and each player's status in our league
const ids = await getPlayerIds();
const ro = await rosterBundle(); notes.push(...ro.notes);
const info = await getLeagueInfo().catch(e => { notes.push('getLeagueInfo failed (' + errText(e) + '): fxStatus and fa are unknown, period taken as the current one'); return null; });
const pinfo = info?.playerInfo || null;
// ownership in effect for each game: the scoring period that contains its start time
const byPeriod = { [ro.period]: ownership(ro.cur) }; if (ro.next) byPeriod[ro.nextPeriod] = ownership(ro.next);
const ownAt = async p => { if (!byPeriod[p]) byPeriod[p] = await getRosters(p).then(r => r.period === p ? ownership(r) : null).catch(e => { notes.push(`period ${p} rosters failed (${errText(e)}): owners for those games are from period ${ro.period}`); return null; }) || byPeriod[ro.period]; return byPeriod[p]; };
const ownNext = byPeriod[ro.nextPeriod] || byPeriod[ro.period];
const M = makeMatcher(ids);

const rows = []; const periods = new Set(); let guessed = false;
for (const g of games) {
  let p = periodForDate(g.startTimeUTC || day, info);
  if (p == null) { p = ro.period; guessed = true; }
  periods.add(p); const own = await ownAt(p);
  const names = { ...(await clubRoster(g.awayTeam.abbrev)), ...(await clubRoster(g.homeTeam.abbrev)) };
  for (const r of await gameRows(g.id)) {
    // full name from the club roster; a player no longer on it only has the box score's "F. Last"
    const n = names[r.pid]; const ini = /^([A-Z])\. (.+)$/.exec(r.name);
    const first = n ? n.first : ini ? ini[1] : '', last = n ? n.last : ini ? ini[2] : r.name;
    const m = M.find({ first, last, team: r.team, pos: r.pos, goalie: r.goalie });
    const fx = m ? m.id : null; const o = fx ? own[fx] : null, nx = fx ? ownNext[fx] : null;
    const line = r.goalie ? { dec: r.dec, sv: r.sv, sa: r.sa, ga: r.ga, so: r.so, g: r.g, a: r.a, toi: r.toi }
      : { g: r.g, a: r.a, ppp: r.ppp, shg: r.shg, gwg: r.gwg, pm: r.pm, sog: r.sog, hit: r.hit, blk: r.blk, pim: r.pim, toi: r.toi };
    rows.push({ fxStatus: fx && pinfo ? (pinfo[fx]?.status || null) : null, name: n ? first + ' ' + last : fx && ids[fx]?.name ? fxDisplay(ids[fx].name) : r.name, team: r.team, opp: r.opp, pos: r.pos, fp: r.fp, ...line, fx,
      own: o ? o.team : null, st: o ? o.st : null, ownNext: nx ? nx.team + ':' + nx.st : null, sal: (nx || o)?.sal ?? null, period: p });
  }
}
if (guessed) notes.push(`no period dates from Fantrax: games taken as period ${ro.period} (the current one)`);
rows.sort((x, y) => y.fp - x.fp);
// free agents and waiver players by Fantrax's own status (never inferred from rosters)
const fa = pinfo ? rows.filter(r => r.fxStatus === 'FA' || r.fxStatus === 'WW').map(r => ({ name: r.name, team: r.team, pos: r.pos, fp: r.fp, fx: r.fx, ...pinfo[r.fx] })) : null;
// cap room next period: active + reserve + dead cap count
const hfdItems = (ro.next || ro.cur).rosters[TEAM_ID]?.rosterItems; const cap = hfdItems ? capOf(hfdItems, MY) : null;
const out = { d: day, at: new Date().toISOString(), period: periods.size ? Math.min(...periods) : (periodForDate(day, info) ?? ro.period), periods: [...periods].sort((a, b) => a - b), currentPeriod: ro.period, nextPeriod: ro.nextPeriod,
  games: games.map(g => `${g.awayTeam.abbrev} ${g.awayTeam.score}-${g.homeTeam.score} ${g.homeTeam.abbrev}${g.gameOutcome?.lastPeriodType && g.gameOutcome.lastPeriodType !== 'REG' ? ' ' + g.gameOutcome.lastPeriodType : ''}`),
  gamesPending: pending.map(gameLabel), gameType: [2], hfdCapRoomNext: cap ? +cap.room.toFixed(2) : null, hfdCap: cap, nPlayerInfo: pinfo ? Object.keys(pinfo).length : 0,
  fa, unmatched: rows.filter(r => !r.fx).map(r => r.name + ' ' + r.team), notes, rows };
writeJSON('data/adhoc/box.json', out); writeJSON(`data/adhoc/box-${day}.json`, out);
// dated copies: keep 14 days
const dir = path.join(ROOT, 'data', 'adhoc');
for (const f of fs.readdirSync(dir)) { const m = f.match(/^box-(\d{4}-\d{2}-\d{2})\.json$/); if (m && Date.now() - Date.parse(m[1]) > 14 * 864e5) fs.unlinkSync(path.join(dir, f)); }
console.log(day, 'period', out.period, '|', games.length, 'games', pending.length, 'pending |', rows.length, 'players |', out.unmatched.length, 'unmatched', notes.length ? '| ' + notes.join('; ') : '');
