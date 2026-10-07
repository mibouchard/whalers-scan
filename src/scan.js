// Daily minors scan, headless. Reads every league, matches players to Fantrax (ownership from the next scoring period, so
// this week's claims count), runs the cross-league plausibility check, scores with the shared engine, and writes:
//   data/latest.json       the document the Front Office reads ("minors/latest" shape; rows are pipe-delimited, see cols)
//   data/YYYY-MM-DD.json   that day's snapshot (kept 120 days)
//   data/status.json       per-league outcome of the last run
//
//   node src/scan.js                  full scan
//   node src/scan.js --retry-failed   re-read only the leagues that failed in today's scan and merge them in
//   node src/scan.js KHL VHL          debug a subset (also via env LEAGUES="KHL VHL"): writes data/status-debug.json only
//
// A league that fails (after three tries, or past its deadline, or returning nothing when it had rows before) keeps
// yesterday's rows: its status reads "carried <date of the data>" and the reason goes under `errors`.
import fs from 'node:fs';
import path from 'node:path';
import { loadEngine } from './env.js';
import { ROOT, MY, torontoDate, splitArgs, readJSON, writeJSON } from './lib/config.js';
import { getLeagueInfo } from './lib/fantrax.js';
import { errText } from './lib/util.js';
import { LEAGUES, collectLeagues, checkRows, saveRows } from './lib/pipeline.js';
import { recsFromDoc, applyToDoc, akFor } from './lib/plausible.js';

const WS = loadEngine();
const argv = [...process.argv.slice(2), ...splitArgs(process.env.LEAGUES)];
const retryFailed = argv.includes('--retry-failed') || process.env.RETRY_FAILED === '1';
const only = argv.filter(a => !a.startsWith('--'));
const unknown = only.filter(l => !LEAGUES.includes(l));
if (unknown.length) { console.error(`unknown league(s): ${unknown.join(', ')}. Known: ${LEAGUES.join(' ')}`); process.exit(2); }
const debug = only.length > 0;
const today = torontoDate(), now = new Date().toISOString();
const prev = readJSON('data/latest.json');

const COLS = { sk: ['lg', ...WS.SK], g: ['lg', ...WS.GK] };
const LISTS = ['owned', 'avail', 'und', 'risers', 'goalies', 'notInFx'];
const NOTES = {
  NHL: 'NHL rows are club rosters; a player with no NHL games this season has gp 0 and a blank nhle.',
  Names: "Names are matched to Fantrax exactly once accents, apostrophes, hyphens and spacing are ignored (O'Reilly = OReilly). Only KHL, VHL and MHL names, which are transliterated from Russian, also match across spellings (Dmitry/Dmitri) and word order. A goalie only matches a goalie, and a forward never matches a Fantrax defenceman (or the reverse).",
  Russia: 'VHL and MHL names are transliterated from Russian and matched to Fantrax by name only (no birthdates), so common names can collide: verify before acting on a VHL/MHL match.',
  Ages: "The ak column says how an age is known: 'dob' = from a real birthdate, 'est' = estimated (NCAA class year when the roster page has no birthdate; Czech age bands 19 = U20, 22 = U24, 25 = 24+), blank = no age (Allsvenskan, J20, VHL, MHL). Rows with no age rank below rows with one in avail, und and risers.",
  Draft: "dr: 'post' = an NHL club holds him or his real birthdate shows he has been through an NHL draft; 'pre' = no NHL club and not yet through a draft (never claimable); blank = unknown (no real birthdate). Estimated ages never decide dr.",
  Matches: "mq 'amb' = the same Fantrax player was matched to more than one person and none is clearly the real one: verify before acting. Namesakes that could be told apart lost their match and are listed under checks.dropped; rows with no age whose Fantrax id belongs to veterans are listed under checks.veteran and kept out of avail, und and risers.",
  PPP: "ppp is power-play points where the league publishes them and power-play goals otherwise; blank where it publishes neither. The `ppp` map says which per league ('points', 'goals' or 'none').",
  Claims: 'Ownership comes from the next scoring period, so claims made this week already count. If that fell back to the current period, notes.Fantrax says so.',
  FreeAgents: 'avail, und, risers and unowned goalies list only players Fantrax itself shows as free agents (FA) or on waivers (WW), counted from their first game. A player with no Fantrax id is never listed there: the best of those are under notInFx.',
  Carried: "A league whose status is 'carried YYYY-MM-DD' failed today: its rows are the ones from that date and the reason is under errors. Carried rows older than 7 days are dropped.",
  HfdMissing: `hfdMissing lists ${MY} minors (next period's roster) that were not found in any scanned league.`,
};
const blank = () => ({ d: today, at: now, src: 'github-actions', cols: COLS, cov: {}, status: {}, errors: {}, stale: {}, fantrax: {}, ppp: {}, leaders: {},
  owned: [], avail: [], und: [], risers: [], goalies: [], notInFx: [], hfdMissing: [], checks: { dropped: [], ambiguous: [], veteran: [], rejected: [] }, leagueNotes: {},
  pending: ['Swiss NL', 'DEL', 'Mestis / Finnish U20', 'Slovak Extraliga', 'BCHL'], notes: { ...NOTES } });

// ---- which leagues to read ----
let mode = debug ? 'debug' : 'full', targets = debug ? only : LEAGUES, base = null;
if (retryFailed) {
  const sameDay = prev && prev.at && torontoDate(new Date(prev.at)) === today;
  const failedBefore = sameDay ? Object.keys(prev.errors || {}).filter(l => LEAGUES.includes(l)) : [];
  if (!sameDay || prev.fantrax?.leagueInfo && prev.fantrax.leagueInfo !== 'ok' || prev.errors?.Fantrax) console.log('retry-failed: no usable scan from today, running a full scan');
  else if (!failedBefore.length) { console.log('retry-failed: no failed leagues in today\'s scan, nothing to do'); process.exit(0); }
  else { mode = 'retry-failed'; targets = failedBefore; base = prev; console.log('retry-failed:', targets.join(' ')); }
}

const res = blank();
if (base) for (const k of ['pending']) res[k] = base[k] ?? res[k];

// ---- Fantrax ----
let fx = null, info = null;
try { fx = await WS.fantrax(); res.fantrax = { rosters: 'ok', period: fx.period, ownPeriod: fx.ownPeriod, nextPeriod: fx.notes.length ? fx.notes.join('; ') : 'ok' }; if (fx.notes.length) res.notes.Fantrax = fx.notes.join('; '); }
catch (e) { res.fantrax = { rosters: 'ERR ' + errText(e) }; res.errors.Fantrax = 'player pool / rosters: ' + errText(e); }
// Fantrax's own status per player in our league (FA, WW = waivers, T = on a team). The free-agent lists keep only FA/WW.
// Without this feed nobody is treated as free: the lists stay empty and a note says why.
try { info = await getLeagueInfo(); if (!info || !info.playerInfo) throw new Error('no playerInfo in the response'); res.fantrax.leagueInfo = 'ok'; }
catch (e) {
  info = null; res.fantrax.leagueInfo = 'ERR ' + errText(e); res.errors.Fantrax = [res.errors.Fantrax, 'getLeagueInfo: ' + errText(e)].filter(Boolean).join('; ');
  res.notes.Fantrax = [res.notes.Fantrax, 'Fantrax getLeagueInfo failed, so free-agent status is unknown: avail, und, risers and unowned goalies are empty today.'].filter(Boolean).join(' ');
}
const pinfo = info?.playerInfo || null;
if (fx && pinfo) for (const [id, v] of Object.entries(pinfo)) if (v?.eligiblePos) fx.elig[id] = v.eligiblePos;
const free = id => !!pinfo && ['FA', 'WW'].includes(pinfo[id]?.status);

// ---- leagues ----
const seasonRows = lg => Array.isArray(prev?.cov?.[lg]) || /^carried /.test(prev?.status?.[lg] || '') || WS.histTotals(lg).some(t => t[1] > 0);
let run = { collected: {}, failed: {}, empty: [] };
if (fx) run = await collectLeagues(WS, { only: targets, fx, hadRows: seasonRows, log: console.log, budgetMs: (+process.env.SCAN_BUDGET_MIN || 22) * 60000 });
else for (const lg of targets) run.failed[lg] = 'Fantrax player pool unavailable: ' + res.fantrax.rosters;

// cross-league plausibility: fresh rows, plus the saved rows that will be reused (a retry's untouched leagues, or the
// leagues that failed just now and are about to be carried forward)
const saved = base || prev;
const reused = lg => base ? !run.collected[lg] : !!run.failed[lg];
// a document from before the ak / mq columns: the old columns are a prefix of today's, so read and mark it with today's
if (saved?.cols?.sk && COLS.sk.slice(0, saved.cols.sk.length).join() === saved.cols.sk.join() && COLS.g.slice(0, (saved.cols.g || []).length).join() === (saved.cols.g || []).join()) saved.cols = COLS;
const savedRecs = saved && fx ? recsFromDoc(saved, lg => !reused(lg)) : [];
if (fx) {
  const rep = checkRows(WS, fx, run.collected, savedRecs, { save: !debug });
  for (const k of Object.keys(res.checks)) res.checks[k] = [...new Set([...(base?.checks?.[k] || []), ...(rep[k] || [])])].slice(0, 80);
  if (saved) applyToDoc(saved, savedRecs);
}

const OPTS = { minGP: 1, maxAge: 24, nAvail: 12, nUnd: 6, nNotInFx: 4 };
const section = {}; // lg -> { owned, avail, und, risers, goalies, notInFx, cov, status, leaders, ppp, notes }
for (const [lg, c] of Object.entries(run.collected)) {
  const nDays = debug ? 0 : WS.trend(lg, c.rows);
  // trend fields are set by WS.trend, so summarise after it
  const r = WS.summarize(lg, c.rows, { ...OPTS, ...(lg === 'NHL' ? { ownedSt: ['MINORS'], maxAge: 23 } : {}), free });
  // leaders: [name, team, value, gp, owner, fantraxId, nhlRights, fantraxStatus, pos, age, dr]; status FA or WW = an unclaimed free agent
  for (const x of Object.values(r.leaders)) if (x) x[7] = x[5] && pinfo ? (pinfo[x[5]]?.status || '') : '';
  section[lg] = { owned: r.owned, avail: r.avail, und: r.undrafted, risers: r.risers, goalies: r.goalies, notInFx: r.notInFx, cov: [r.nSk, r.nG, r.matched, r.owned.length, nDays],
    status: c.meta.partial ? 'partial: ' + c.meta.partial : 'ok', leaders: r.leaders, ppp: c.meta.ppp || 'none', notes: c.meta.notes };
  if (c.meta.partial) res.errors[lg] = 'partial: ' + c.meta.partial;
}
// a league's part of a saved document
const fromDoc = (doc, lg) => {
  const s = { cov: doc.cov?.[lg], status: doc.status?.[lg], leaders: doc.leaders?.[lg], ppp: doc.ppp?.[lg], notes: doc.leagueNotes?.[lg] || [] };
  // rows from a document written before the ak / mq columns existed are padded, with ak worked out from the league; a
  // player with no NHL club and no real birthdate has an unknown draft status whatever the old document said
  for (const k of LISTS) { const cols = k === 'goalies' ? COLS.g : COLS.sk; const iAge = cols.indexOf('age') - 1, iAk = cols.indexOf('ak') - 1; s[k] = (doc[k] || []).filter(x => x.startsWith(lg + '|')).map(x => { const v = x.slice(lg.length + 1).split('|'); while (v.length < cols.length - 1) v.push(''); if (!v[iAk]) v[iAk] = akFor(lg, v[iAge]); if (k === 'und' && v[iAk] !== 'dob') v[cols.indexOf('dr') - 1] = ''; return v.join('|'); }); }
  return s;
};
const days = d => (Date.parse(today) - Date.parse(d)) / 864e5;
for (const lg of LEAGUES) {
  if (section[lg]) continue;
  if (run.empty.includes(lg)) { section[lg] = { cov: 'no games yet', status: 'no games yet' }; continue; }
  const why = run.failed[lg];
  if (base && !why) { section[lg] = fromDoc(base, lg); if (base.errors?.[lg]) res.errors[lg] = base.errors[lg]; continue; } // retry mode: a league that was fine
  if (debug && !why) continue;
  // failed today: carry the last good rows forward (keeping the date they are from), unless they are over a week old
  const src = base || prev; const ps = src?.status?.[lg] || ''; const m = /^carried (\d{4}-\d{2}-\d{2})/.exec(ps);
  const from = m ? m[1] : (ps === 'ok' || ps.startsWith('partial')) ? src.d : null;
  res.errors[lg] = why || 'not read';
  if (from && Array.isArray(src.cov?.[lg]) && days(from) <= 7) section[lg] = { ...fromDoc(src, lg), status: 'carried ' + from };
  else section[lg] = { cov: 'ERR ' + res.errors[lg], status: 'ERR ' + res.errors[lg] };
}
for (const lg of LEAGUES) {
  const s = section[lg]; if (!s) continue;
  res.cov[lg] = s.cov; res.status[lg] = s.status;
  if (s.leaders) res.leaders[lg] = s.leaders;
  if (s.ppp) res.ppp[lg] = s.ppp;
  if (s.notes && s.notes.length) res.leagueNotes[lg] = s.notes;
  // rows reused from a saved document: a player listed as free there must still be free per Fantrax today
  const reusedRows = !run.collected[lg];
  const stillFree = (k, x) => { if (!reusedRows || k === 'owned' || k === 'notInFx') return true; const v = x.split('|'); return (k === 'goalies' && v[1]) ? true : free(v[0]); };
  for (const k of LISTS) for (const x of s[k] || []) if (stillFree(k, x)) res[k].push(lg + '|' + x);
}

// ---- staleness: a league whose total games played has not moved for 4+ daily points while other leagues moved ----
if (!debug) {
  const flat = {}; // lg -> [first day of the flat run, points in it]
  for (const lg of LEAGUES) {
    const t = WS.histTotals(lg).filter(x => x[1] > 0); if (t.length < 4) continue;
    let n = 1; while (n < t.length && t[t.length - 1 - n][1] === t[t.length - 1][1]) n++;
    flat[lg] = [t[t.length - n][0], n];
  }
  const moving = Object.values(flat).filter(f => f[1] < 4).length;
  for (const [lg, [since, n]] of Object.entries(flat)) if (n >= 4 && moving >= 3) res.stale[lg] = `no change in games played over the last ${n} daily points (since ${since}): the site may be serving old numbers`;
  if (Object.keys(res.stale).length) res.notes.Stale = 'Possibly stale leagues (totals unchanged while others moved): ' + Object.keys(res.stale).join(', ') + '.';
}

// ---- HFD minors not found in any scanned league ----
if (fx && !debug) {
  const seen = new Set([...res.owned, ...res.goalies].map(s => s.split('|')[1]));
  res.hfdMissing = Object.entries(fx.own).filter(([id, o]) => o[0] === MY && o[1] === 'MINORS' && !seen.has(id)).map(([id]) => ({ id, name: fx.byId[id]?.[0] || null, nhlTeam: fx.byId[id]?.[1] || null, pos: fx.byId[id]?.[2] || null }));
  const dark = LEAGUES.filter(lg => !Array.isArray(res.cov[lg]) && res.status[lg] !== 'no games yet');
  if (dark.length) res.notes.HfdMissing += ` No data today from ${dark.join(', ')}, so a player there shows as missing.`;
}

// ---- write ----
const failedNow = Object.keys(res.errors);
const status = { d: today, at: now, mode, status: res.status, errors: res.errors, fantrax: res.fantrax, stale: res.stale, subset: debug ? only : [], ...(mode === 'retry-failed' ? { retried: targets } : {}) };
if (debug) {
  // a debug run never touches latest.json or status.json
  writeJSON('data/status-debug.json', { ...status, cov: res.cov, checks: res.checks, leagueNotes: res.leagueNotes }, 1);
} else {
  const doc = JSON.stringify(res);
  writeJSON('data/latest.json', res); fs.writeFileSync(path.join(ROOT, 'data', today + '.json'), doc);
  writeJSON('data/status.json', status, 1);
  if (mode === 'full') saveRows({ at: now, d: today, status: res.status, errors: res.errors, leagues: Object.fromEntries(Object.entries(run.collected).map(([lg, c]) => [lg, c.rows])) });
  // keep 120 days of daily snapshots
  const out = path.join(ROOT, 'data');
  for (const f of fs.readdirSync(out)) { const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/); if (m && (Date.now() - new Date(m[1])) > 120 * 864e5) fs.unlinkSync(path.join(out, f)); }
}
const good = Object.values(res.status).filter(v => v === 'ok' || v === 'no games yet').length;
console.log(`done (${mode}): ${good} ok, ${failedNow.length} with errors${failedNow.length ? ': ' + failedNow.map(k => `${k} [${res.status[k] || res.errors[k]}]`).join(', ') : ''}`);
