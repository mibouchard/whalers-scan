// One-off helper: every team's goalies in our league with NHL team, Fantrax status and salary, last season's NHL
// workload (from the NHL player page) and this season's games, plus each fantasy team's cap room.
// Writes data/adhoc/goalies.json.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env.js';

const L = 'fs61ldkdmow7aw2h', CAP = 114.4;
const TEAMS = { "m1hfr04lmow7aw2v": "HFD", "4psrznwkmow7aw2u": "CGY", "h32ctyahmow7aw2v": "BOS", "svnb4s7amow7aw2u": "CGS", "fay1fny2mow7aw2u": "VAN", "nw53mrdzmow7aw2v": "QUE", "ps4l4b6mmow7aw2v": "WPG", "39n75kyjmow7aw2u": "CHI", "tu2c5havmow7aw2v": "WAS", "tsr78hmdmow7aw2u": "ANA", "nx9xgs2mmow7aw2u": "COL", "br7rvnwsmow7aw2u": "OTT", "z64j08mgmow7aw2u": "MTL", "vm1rdwvtmow7aw2u": "CAR", "hghiywi2mow7aw2u": "EDM", "4yx4ssw6mow7aw2v": "DET" };
const j = u => fetch(u).then(r => { if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); });
const ro = await j(`https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${L}`);
const next = await j(`https://www.fantrax.com/fxea/general/getTeamRosters?leagueId=${L}&period=${ro.period + 1}`).catch(() => ro);
const ids = await j('https://www.fantrax.com/fxea/general/getPlayerIds?sport=NHL');
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/gi, '').toLowerCase();

// NHL goalies on every club: id by name
const T = ['ANA', 'BOS', 'BUF', 'CGY', 'CAR', 'CHI', 'COL', 'CBJ', 'DAL', 'DET', 'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NSH', 'NJD', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT', 'SJS', 'SEA', 'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WSH', 'WPG'];
const nhlG = {};
for (let i = 0; i < T.length; i += 4) await Promise.all(T.slice(i, i + 4).map(async t => {
  const r = await j(`https://api-web.nhle.com/v1/roster/${t}/current`).catch(() => ({}));
  for (const g of r.goalies || []) nhlG[norm(g.firstName.default + g.lastName.default)] = { id: g.id, team: t };
}));
const land = {};
async function career(pid) {
  if (land[pid]) return land[pid];
  const p = await j(`https://api-web.nhle.com/v1/player/${pid}/landing`).catch(() => null); if (!p) return null;
  const reg = (p.seasonTotals || []).filter(s => s.leagueAbbrev === 'NHL' && s.gameTypeId === 2);
  const by = y => reg.filter(s => s.season === y).reduce((m, s) => ({ gp: (m.gp || 0) + (s.gamesPlayed || 0), gs: (m.gs || 0) + (s.gamesStarted || 0), w: (m.w || 0) + (s.wins || 0), svp: s.savePctg ?? m.svp, gaa: s.goalsAgainstAvg ?? m.gaa }), {});
  return land[pid] = { age: p.birthDate ? Math.floor((Date.now() - new Date(p.birthDate)) / 3.15576e10) : null, last: by(20252026), now: by(20262027), careerGP: p.careerTotals?.regularSeason?.gamesPlayed ?? null };
}

const out = { at: new Date().toISOString(), period: ro.period + 1, teams: {} };
for (const [tid, t] of Object.entries(next.rosters)) {
  const items = t.rosterItems;
  const used = items.filter(i => i.status === 'ACTIVE' || i.status === 'RESERVE').reduce((s, i) => s + i.salary / 1e6, 0);
  const goalies = [];
  for (const i of items.filter(i => /G/.test(i.position))) {
    const nm = (ids[i.id] || {}).name || i.id; const [last, first] = nm.split(', ');
    const n = nhlG[norm((first || '') + (last || ''))];
    goalies.push({ id: i.id, name: (first ? first + ' ' : '') + last, fxTeam: (ids[i.id] || {}).team, nhlTeam: n ? n.team : null, status: i.status, salary: +(i.salary / 1e6).toFixed(3), ...(n ? await career(n.id) : {}) });
  }
  out.teams[TEAMS[tid] || tid] = { capRoom: +(CAP - used).toFixed(2), main: items.filter(i => i.status === 'ACTIVE' || i.status === 'RESERVE').length, goalies };
}
fs.mkdirSync(path.join(ROOT, 'data', 'adhoc'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'adhoc', 'goalies.json'), JSON.stringify(out, null, 1));
console.log('teams', Object.keys(out.teams).length);
