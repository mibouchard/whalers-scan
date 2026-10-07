// League constants shared by the scan and every tool. League-specific values live in /config.json; this file adds the
// things that never change during a season (team codes, roster limits) and small date/argument helpers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
export const LEAGUE_ID = CONFIG.leagueId;
export const TEAM_ID = CONFIG.teamId;
export const CAP = CONFIG.cap;
export const DEAD_CAP = CONFIG.deadCap || {};
export const TZ = 'America/Toronto';

// Fantrax team id -> short code (the one TEAMS map; the engine gets it injected by src/env.js)
export const TEAMS = { m1hfr04lmow7aw2v: 'HFD', '4psrznwkmow7aw2u': 'CGY', h32ctyahmow7aw2v: 'BOS', svnb4s7amow7aw2u: 'CGS', fay1fny2mow7aw2u: 'VAN', nw53mrdzmow7aw2v: 'QUE', ps4l4b6mmow7aw2v: 'WPG', '39n75kyjmow7aw2u': 'CHI', tu2c5havmow7aw2v: 'WAS', tsr78hmdmow7aw2u: 'ANA', nx9xgs2mmow7aw2u: 'COL', br7rvnwsmow7aw2u: 'OTT', z64j08mgmow7aw2u: 'MTL', vm1rdwvtmow7aw2u: 'CAR', hghiywi2mow7aw2u: 'EDM', '4yx4ssw6mow7aw2v': 'DET' };
export const short = tid => TEAMS[tid] || tid;
export const MY = short(TEAM_ID);

// Roster rules: main roster (active + reserve) 18-20, active exactly 14, reserve up to 6, minors up to 25.
export const LIMITS = { mainMin: 18, mainMax: 20, active: 14, reserveMax: 6, minorsMax: 25 };
export const NHL_TEAMS = ['ANA', 'BOS', 'BUF', 'CGY', 'CAR', 'CHI', 'COL', 'CBJ', 'DAL', 'DET', 'EDM', 'FLA', 'LAK', 'MIN', 'MTL', 'NSH', 'NJD', 'NYI', 'NYR', 'OTT', 'PHI', 'PIT', 'SJS', 'SEA', 'STL', 'TBL', 'TOR', 'UTA', 'VAN', 'VGK', 'WSH', 'WPG'];

// ---- dates (always America/Toronto for "today"; the runner's own time zone never matters) ----
const parts = (d, opt) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hourCycle: 'h23', ...opt }).formatToParts(d).map(p => [p.type, p.value]));
export const torontoDate = (d = new Date()) => { const p = parts(d, { year: 'numeric', month: '2-digit', day: '2-digit' }); return `${p.year}-${p.month}-${p.day}`; };
export const torontoHour = (d = new Date()) => +parts(d, { hour: '2-digit' }).hour;
export const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
// ISO timestamp with the Toronto offset, e.g. 2026-10-07T05:16:23-04:00
export function isoToronto(d = new Date()) {
  const p = parts(d, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const off = Math.round((local - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  const s = off < 0 ? '-' : '+', a = Math.abs(off);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
// the instant of a Toronto wall-clock time, e.g. torontoInstant('2026-10-06', '23:59:59')
export function torontoInstant(ymd, hms = '12:00:00') {
  let t = Date.parse(`${ymd}T${hms}Z`);
  for (let i = 0; i < 2; i++) { const iso = isoToronto(new Date(t)); const off = (iso.endsWith('Z') ? 0 : (iso.slice(-6, -5) === '-' ? -1 : 1) * (+iso.slice(-5, -3) * 60 + +iso.slice(-2))); t = Date.parse(`${ymd}T${hms}Z`) - off * 60000; }
  return new Date(t);
}

// ---- arguments: tools accept them on the command line or (from the workflows) in the ARGS environment variable ----
// ARGS is split like a shell would, honouring quotes: `"Ottawa Senators" 2026-10-06` -> ['Ottawa Senators', '2026-10-06'].
export function splitArgs(s) {
  const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m;
  while ((m = re.exec(s || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
export const cliArgs = () => [...process.argv.slice(2), ...splitArgs(process.env.ARGS)];
export const readJSON = (rel, dflt = null) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); } catch { return dflt; } };
export function writeJSON(rel, obj, indent) { const f = path.join(ROOT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj, null, indent)); return f; }
