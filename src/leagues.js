// League adapters for the sites that need more than a plain fetch (the rest are in engine/engine.js). Each returns rows
// in the engine's shape:
// skater {sid, first, last, pos, team, gp, g, a, pts, ppp, dob?, age?, prev?, toi?}; goalie {goalie: 1, sid, first, last, pos: 'G', team, gp, svp, gaa, w, min, dob?, age?}.
// `dob` is a real birthdate; `age` without a dob is an estimate (NCAA class year, Czech age band) and never decides draft status.
// Season ids that change yearly are constants at the top.
import vm from 'node:vm';
import { realFetch, UA, sleep, parseHTML, cookieHeader, timeoutSignal } from './env.js';
import { retry } from './lib/util.js';
import { NHL_TEAMS } from './lib/config.js';

export const SEASON = {
  KHL: { season: 's19', tour: '1436' },          // en.khl.ru/stat/players/1436/
  SHL: 'qa98unlbd6',                              // ssgtUuid on shl.se/game-stats/players
  SWE: { Allsvenskan: [20962], J20: [20963, 20964] }, // stats.swehockey.se event ids
};

const num = x => { const v = parseFloat(String(x ?? '').replace(',', '.')); return isNaN(v) ? 0 : v; };
const text = async (u, o) => { const r = await fetch(u, o); if (!r.ok) { const b = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160); throw new Error(`${r.status} ${new URL(u).host} [server ${r.headers.get('server') || '?'}] ${b}`); } return r.text(); };
const json = async (u, o) => JSON.parse(await text(u, o));
const splitFirst = s => { s = s.replace(/ /g, ' ').trim(); const i = s.indexOf(' '); return i < 0 ? ['', s] : [s.slice(0, i), s.slice(i + 1)]; };

// ---------- KHL (en.khl.ru) ----------
// Uses the engine's WS.khl() adapter with a session token from the stats page and a fetch that sends /rest/ calls to the
// site with that session's cookie, one at a time (the site answers parallel calls with an HTML error page). Every call
// gets six tries, and a thrown error (timeout, redirect loop, reset) is retried like a non-JSON answer is.
export async function khl(WS) {
  const pageUrl = `https://en.khl.ru/stat/players/${SEASON.KHL.tour}/`;
  const sess = await retry(async () => {
    const page = await realFetch(pageUrl, { headers: UA, signal: timeoutSignal(60000) });
    const m = (await page.text()).match(/bitrix_sessid['"]\s*:\s*['"]([0-9a-f]+)['"]/);
    if (!m) throw new Error('KHL: no session token on the stats page (HTTP ' + page.status + ')');
    return m[1];
  }, 3);
  let q = Promise.resolve();
  const rest = (u, o = {}) => {
    const p = q.then(async () => {
      let last = 'non-JSON answer';
      for (let t = 0; t < 6; t++) {
        const signal = timeoutSignal(60000);
        try {
          const r = await realFetch('https://en.khl.ru' + u, { ...o, headers: { ...UA, ...(o.headers || {}), Cookie: cookieHeader('https://en.khl.ru/'), 'X-Requested-With': 'XMLHttpRequest', Referer: pageUrl }, signal });
          const txt = await r.text();
          if (txt.trim().startsWith('{')) { await sleep(150); return new Response(txt, { status: 200, headers: { 'Content-Type': 'application/json' } }); }
          last = 'non-JSON answer (HTTP ' + r.status + ')';
        } catch (e) { last = e.message + (e.cause ? ' (' + (e.cause.code || e.cause.message || e.cause) + ')' : ''); }
        if (signal.aborted && signal.reason?.message === 'deadline') break; // the league's deadline passed: stop at once
        await sleep(1500 * (t + 1));
      }
      throw new Error('KHL: /rest/ kept failing: ' + last);
    });
    q = p.catch(() => { }); return p;
  };
  return WS.khl(SEASON.KHL.season, SEASON.KHL.tour, { fetch: rest, sess })();
}

// ---------- Russian transliteration (VHL, MHL) ----------
const M = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
export const tr = w => { w = w.toLowerCase().replace(/ый$/, 'y').replace(/ий$/, 'iy'); let o = ''; for (let i = 0; i < w.length; i++) { const c = w[i], p = w[i - 1]; o += (c === 'е' && (i === 0 || 'аеёиоуыэюяъь'.includes(p))) ? 'ye' : (M[c] ?? c); } return o.charAt(0).toUpperCase() + o.slice(1); };
const FIRST = { Aleksandr: 'Alexander', Aleksey: 'Alexei', Aleksei: 'Alexei', Maksim: 'Maxim', Yevgeniy: 'Evgeni', Pyotr: 'Petr', Fyodor: 'Fedor', Arseniy: 'Arseni', Vasiliy: 'Vasili', Matvey: 'Matvei', Timofey: 'Timofei', Nikolay: 'Nikolai', Andrey: 'Andrei', Sergey: 'Sergei' };
const vars = s => [...new Set([s, s.replace(/ks/g, 'x'), s.replace(/ya$/, 'ia'), s.replace(/iy$/, 'i'), s.replace(/yo/g, 'e'), FIRST[s] || s])];
const strip = h => String(h ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// One Russian player row -> engine row. cells: array of HTML strings; H: header texts aligned with cells.
function rusRow(lg, H, c, pos) {
  const ix = k => H.indexOf(k);
  const cell = c.find(x => /href="\/players\/\d+\/">[^<]+</.test(String(x))); if (!cell) return null;
  const id = (String(cell).match(/players\/(\d+)\//) || [])[1];
  const parts = strip(cell).split(/\s+/).filter(w => !/^[А-ЯA-Z]\.$/.test(w));
  const last = tr(parts[0] || ''), first = tr(parts[1] || '');
  const alts = []; for (const f of vars(first)) for (const l of vars(last)) alts.push([f, l]);
  const team = strip(c[ix('Клуб') >= 0 ? ix('Клуб') : ix('Команда')]).split(/\s+/).map(tr).join(' ');
  const gp = num(strip(c[ix('И')]));
  if (pos === 'G') return { goalie: 1, sid: lg + id, first, last, alts: alts.slice(0, 12), pos: 'G', team, gp, w: num(strip(c[ix('В')])), svp: strip(c[ix('%ОБ')]) ? (num(strip(c[ix('%ОБ')])) / 100).toFixed(3) : '', gaa: strip(c[ix('КН')]), min: strip(c[ix('ВП')]) };
  return { sid: lg + id, first, last, alts: alts.slice(0, 12), pos, team, gp, g: num(strip(c[ix('Ш')])), a: num(strip(c[ix('А')])), pts: num(strip(c[ix('О')])), ppp: null, toi: strip(c[ix('ВП/И')]) };
}

// VHL (vhlru.ru): the stats page serves three full HTML tables: goalies, defence, forwards.
export async function vhl() {
  const d = parseHTML(await text('https://vhlru.ru/stats/players/'));
  const rows = []; let sk = 0;
  for (const t of d.querySelectorAll('table.table-players')) {
    const H = [...t.querySelectorAll('thead th')].map(h => h.textContent.trim());
    const pos = H.includes('%ОБ') ? 'G' : (sk++ === 0 ? 'D' : 'F');
    for (const trr of t.querySelectorAll('tbody tr')) { const r = rusRow('VHL', H, [...trr.children].map(td => td.innerHTML), pos); if (r) rows.push(r); }
  }
  if (!rows.length) throw new Error('VHL: no player tables found');
  return rows;
}

// MHL (mhl.khl.ru): rows are JavaScript arrays (goalies_Data, defenses_Data, forwards_Data) feeding the page's tables.
function jsArray(src, name) {
  const i = src.indexOf(name + ' = ['); if (i < 0) return null;
  let j = src.indexOf('[', i), depth = 0, q = null;
  for (let k = j; k < src.length; k++) {
    const ch = src[k];
    if (q) { if (ch === '\\') k++; else if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') q = ch; else if (ch === '[') depth++; else if (ch === ']' && --depth === 0) return vm.runInNewContext('(' + src.slice(j, k + 1) + ')');
  }
  return null;
}
export async function mhl() {
  const src = await text('https://mhl.khl.ru/stat/players/');
  const d = parseHTML(src); const rows = [];
  for (const [id, name, pos] of [['table_stat_players_goalies', 'goalies_Data', 'G'], ['table_stat_players_defenses', 'defenses_Data', 'D'], ['table_stat_players_forwards', 'forwards_Data', 'F']]) {
    const t = d.getElementById(id); const data = jsArray(src, name); if (!t || !data) continue;
    const H = [...t.querySelectorAll('thead th')].map(h => h.textContent.trim());
    for (const c of data) { const r = rusRow('MHL', H, c, pos); if (r) rows.push(r); }
  }
  if (!rows.length) throw new Error('MHL: no player data found');
  return rows;
}

// SHL (shl.se): full skater and goalie summaries with birthdates. A player who changed clubs is listed once per club:
// rows are merged by player uuid (identical repeats are dropped, split seasons are added up under the club with most games).
export function mergeByUuid(list, sumKeys) {
  const m = new Map();
  for (const r of list) {
    const o = m.get(r.sid); if (!o) { m.set(r.sid, { ...r, _gp: r.gp }); continue; }
    if (o.team === r.team) continue; // the same line twice
    if (r.gp > o._gp) { o.team = r.team; o._gp = r.gp; if (r.toi) o.toi = r.toi; if (r.svp) { o.svp = r.svp; o.gaa = r.gaa; } }
    for (const k of sumKeys) o[k] = (+o[k] || 0) + (+r[k] || 0);
  }
  return [...m.values()].map(({ _gp, ...r }) => r);
}
export async function shl() {
  const get = k => json(`https://www.shl.se/api/statistics-v2/stats-info/${k}?count=2000&ssgtUuid=${SEASON.SHL}&provider=statnet`, { headers: { Accept: 'application/json', Referer: 'https://www.shl.se/game-stats/players' } }).then(j => j[0].stats);
  const [sk, gk] = await Promise.all([get('players_summary'), get('goalkeepers_summary')]);
  const rows = mergeByUuid(sk.filter(s => s.info && s.info.uuid && s.info.position !== 'GK').map(s => ({ sid: s.info.uuid, first: s.info.firstName, last: s.info.lastName, pos: s.info.position, team: s.info.teamCode, gp: +s.GP, g: +s.G, a: +s.A, pts: +s.TP, ppp: null, dob: s.info.birthDate, toi: s.TOI_GP || '' })), ['gp', 'g', 'a', 'pts']);
  rows.push(...mergeByUuid(gk.filter(s => s.info && s.info.uuid).map(s => ({ goalie: 1, sid: s.info.uuid, first: s.info.firstName, last: s.info.lastName, pos: 'G', team: s.info.teamCode, gp: +s.GPI, svp: s.SVSPerc ? (parseFloat(s.SVSPerc) / 100).toFixed(3) : '', gaa: s.GAA, w: +s.W || 0, min: s.MIP, dob: s.info.birthDate })), ['gp', 'w']));
  return rows;
}

// HockeyAllsvenskan + J20 (stats.swehockey.se PlayersByTeam pages). No birthdates.
export async function swe(lg) {
  const rows = [];
  for (const ev of SEASON.SWE[lg]) {
    const d = parseHTML(await text('https://stats.swehockey.se/Players/Statistics/PlayersByTeam/' + ev));
    let team = '', mode = null;
    for (const trr of d.querySelectorAll('tr')) {
      const c = [...trr.children]; if (!c.length) continue;
      const k = c[0].getAttribute('class') || '';
      if (/tdTitle/.test(k)) { if (c.length > 1) { team = c[0].textContent.trim(); mode = null; } continue; }
      if (/tdHeader/.test(k)) { const h = c.map(x => x.textContent.trim()); mode = h.includes('Pos') ? 'sk' : h.includes('GPI') ? 'gk' : null; continue; }
      if (!/tdOdd|tdNormal/.test(k) || !mode) continue;
      const v = c.map(x => x.textContent.trim());
      const nm = v[2].replace(/\*+$/, ''); const [last, first] = nm.split(', ');
      const sid = ev + ':' + team + ':' + nm;
      if (mode === 'sk') { if (v[3] === 'GK') continue; rows.push({ sid, first: first || '', last, pos: /D/.test(v[3]) ? 'D' : v[3], team, gp: num(v[4]), g: num(v[5]), a: num(v[6]), pts: num(v[7]), ppp: null }); }
      else rows.push({ goalie: 1, sid, first: first || '', last, pos: 'G', team, gp: num(v[5]), min: v[6], svp: v[10] && v[10] !== 'N/A' ? (num(v[10]) / 100).toFixed(3) : '', gaa: v[11], w: num(v[13]) });
    }
  }
  if (!rows.length) throw new Error(lg + ': no rows parsed');
  return rows;
}

// NCAA (collegehockeynews.com): every D1 skater, qualified goalies, last season's P/GP.
// Ages: the stats pages only give the class year, so `age` is an estimate (Fr 19 ... Gr 23) and must never decide
// draft status: a 2027-eligible freshman would look already passed over. Real birthdates are taken from the team roster
// pages when those list them (cached in state/ws.dob.ncaa.json, refreshed weekly); a player without one keeps the
// estimate and gets draft status "unknown".
const CHN = 'https://www.collegehockeynews.com';
export function parseBirth(s) {
  s = String(s || '').trim(); let m;
  const ok = (y, mo, d) => (y >= 1990 && y <= 2015 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return ok(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) { let y = +m[3]; if (y < 100) y += y > 30 ? 1900 : 2000; return ok(y, +m[1], +m[2]); }
  if (/^[A-Za-z]{3,9}\.? \d{1,2},? \d{4}$/.test(s)) { const t = new Date(s.replace('.', '') + ' UTC'); return isNaN(t) ? null : ok(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
  return null;
}
// roster page -> { playerId: 'YYYY-MM-DD' } from any table that has a birthdate column
export function rosterBirths(doc) {
  const out = {};
  for (const t of doc.querySelectorAll('table')) {
    let col = -1;
    for (const trr of t.querySelectorAll('tr')) {
      const cells = [...trr.children];
      const h = cells.findIndex(c => /^(dob|d\.o\.b\.|born|birth ?date|birthdate)$/i.test(c.textContent.trim()));
      if (h >= 0) { col = h; continue; }
      if (col < 0 || !cells[col]) continue;
      const a = trr.querySelector('a[href*="/players/"]'); const b = parseBirth(cells[col].textContent);
      if (a && b) out[a.getAttribute('href').split('/').filter(Boolean).pop()] = b;
    }
  }
  return out;
}
async function ncaaDobs(ls, statsDoc, season, notes) {
  const C = ls.get('ws.dob.ncaa', { s: null, d: null, m: {} });
  if (C.s === season && C.d && (Date.now() - new Date(C.d)) < 7 * 864e5) return C.m || {};
  const m = {}; let pages = 0, failed = 0;
  try {
    const links = [...new Set([...statsDoc.querySelectorAll('a[href*="/reports/team/"]')].map(a => a.getAttribute('href')))].slice(0, 80);
    const end = Date.now() + 90000; // birthdates are a bonus: never spend more than a minute and a half on them
    for (let i = 0; i < links.length && Date.now() < end; i += 4) await Promise.all(links.slice(i, i + 4).map(async href => {
      try { Object.assign(m, rosterBirths(parseHTML(await text(new URL(href.replace('/reports/team/', '/reports/roster/'), CHN).href)))); pages++; } catch (e) { failed++; }
    }));
    if (!links.length) notes.push('no team links on the stats page: no birthdates');
  } catch (e) { notes.push('birthdates: ' + e.message); }
  const n = Object.keys(m).length;
  notes.push(n ? `birthdates for ${n} players from ${pages} roster pages` : `roster pages list no birthdates (${pages} read, ${failed} failed): ages are class-year estimates and draft status is unknown`);
  // keep older birthdates when a refresh finds fewer (a birthdate does not change)
  const merged = C.s === season ? { ...(C.m || {}), ...m } : m;
  ls.set('ws.dob.ncaa', { s: season, d: new Date().toISOString().slice(0, 10), m: merged });
  return merged;
}
export async function ncaa(ls) {
  const AGE = { Fr: 19, So: 20, Jr: 21, Sr: 22, Gr: 23 };
  const load = async u => parseHTML(await text(CHN + u));
  const rowsOf = d => [...d.querySelectorAll('table tr')].map(trr => { const a = trr.querySelector('a[href*="/players/"]'); return { c: [...trr.children].map(x => x.textContent.replace(/\u00a0/g, ' ').trim()), id: a ? a.getAttribute('href').split('/').filter(Boolean).pop() : null }; }).filter(r => r.id && r.c.length > 10);
  const y = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  let P = ls.get('ws.prev.ncaa', null);
  if (!P || P.s !== y - 1) { P = { s: y - 1, m: {} }; rowsOf(await load(`/stats/overall.php?season=${y - 1}${y}`)).forEach(r => { const gp = +r.c[5]; if (gp >= 10) P.m[r.id] = +(+r.c[8] / gp).toFixed(2); }); ls.set('ws.prev.ncaa', P); }
  const statsDoc = await load('/stats/overall.php'); const notes = [];
  const dob = await ncaaDobs(ls, statsDoc, y, notes).catch(e => { notes.push('birthdates: ' + e.message); return {}; });
  const rows = rowsOf(statsDoc).map(r => { const [first, last] = splitFirst(r.c[1]); return { sid: r.id, first, last, pos: r.c[3], team: r.c[2], age: AGE[r.c[4]] ?? null, dob: dob[r.id] || undefined, gp: +r.c[5], g: +r.c[6], a: +r.c[7], pts: +r.c[8], ppp: null, prev: P.m[r.id] ?? null, toi: r.c[18] || '' }; });
  rowsOf(await load('/stats/overall-goalie.php')).forEach(r => { const [first, last] = splitFirst(r.c[1]); rows.push({ goalie: 1, sid: r.id, first, last, pos: 'G', team: r.c[2], age: AGE[r.c[3]] ?? null, dob: dob[r.id] || undefined, gp: +r.c[4], w: +r.c[5], min: r.c[9], gaa: r.c[10], svp: r.c[13] }); });
  rows.notes = notes;
  return rows;
}

// Czech Extraliga, from the NHL's own player pages (api-web.nhle.com player/<id>/landing, seasonTotals league "Czechia").
// hokej.cz shut out automated readers (nginx 403s from Oct 24, a Cloudflare challenge from Oct 27, 2026), so the league is
// read player by player instead: every player the NHL has an id for who is, or recently was, in the Extraliga. Undrafted
// players with no NHL id are not covered (they are never claimable before a draft has passed them over anyway).
// The id pool, re-read every run:
//   1. picks of the last four drafts (state/ws.draftids.json) from Czechia or Slovakia (country or amateur league), and
//      Czech and Slovak picks of the 2014 to older drafts from records.nhl.com (which lists each pick's NHL id),
//   2. free draftees whose page showed a Czech line (data/adhoc/draftees.json, any nationality),
//   3. the 32 clubs' prospect lists (api-web.nhle.com prospects/<club>), players born in Czechia or Slovakia,
//   4. players with an NHL id in the Front Office career files (data/fo/careers-*.json: every rostered player and every
//      free agent with recent NHL games) whose last two seasons include Czechia,
//   5. state ws.czech.ids: every id that has had a Czechia line, kept while it was seen in the last 60 days.
// Rows carry the real birthdate (ak = dob) and sid "CZN<nhl id>".
const CZ_LG = 'Czechia';
// team names on some NHL pages are UTF-8 read as Windows-1252 ("HC PlzeÅˆ"): turn them back into "HC Plzeň"
const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
export const fixMoji = s => {
  if (!/[ÃÄÅÆ]/.test(s)) return s;
  const bytes = []; for (const ch of s) { const c = ch.codePointAt(0); if (c < 0x100) bytes.push(c); else if (CP1252[c] != null) bytes.push(CP1252[c]); else return s; }
  const t = Buffer.from(bytes).toString('utf8'); return t.includes('�') ? s : t;
};
export async function czech(ls, opts = {}) {
  const getJ = async u => { const r = await fetch(u, { headers: { 'User-Agent': 'curl/8.5.0', Accept: 'application/json' } }); if (!r.ok) { const e = new Error(`${r.status} ${new URL(u).host}${new URL(u).pathname}`); if (r.status === 404) e.noRetry = true; throw e; } return r.json(); };
  const now = new Date(); const y0 = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1; const season = +`${y0}${y0 + 1}`;
  const today = now.toISOString().slice(0, 10);
  const notes = [];
  const pool = new Map(); // nid -> how
  const add = (nid, how) => { nid = +nid; if (nid && !pool.has(nid)) pool.set(nid, how); };
  // 1. Czech / Slovak picks of the last four drafts
  const ids = opts.draftIds || ls.get('ws.draftids', null) || {};
  const byPick = ids.ids || {};
  for (const y of [y0 - 3, y0 - 2, y0 - 1, y0]) {
    try {
      const j = await retry(() => getJ(`https://api-web.nhle.com/v1/draft/picks/${y}/all`), 3);
      for (const p of j.picks || []) if (['CZE', 'SVK'].includes(p.countryCode) || /CZECH|SLOVAK/i.test(p.amateurLeague || '')) { const m = byPick[`${y}-${p.overallPick}`]; if (m?.nid) add(m.nid, 'draft'); }
    } catch (e) { notes.push(`draft ${y}: ${e.message}`); }
  }
  // 1b. older drafts (2014 on) from the NHL records site, which carries each pick's NHL id; Czech or Slovak picks only
  for (let y = 2014; y < y0 - 3; y++) {
    try {
      const j = await retry(() => getJ(`https://records.nhl.com/site/api/draft?cayenneExp=${encodeURIComponent(`draftYear=${y}`)}`), 2, { base: 1500 });
      for (const r of j.data || []) if (r.playerId && (['CZE', 'SVK'].includes(r.countryCode || r.birthCountry || r.nationalityCode) || /CZECH|SLOVAK/i.test(r.amateurLeague?.name || r.amateurLeague || ''))) add(r.playerId, 'records');
    } catch (e) { notes.push(`records ${y}: ${e.message}`); break; }
  }
  // 2. free draftees with a Czech line on yesterday's page
  for (const r of opts.draftees || []) if (r.nid && /Czech/.test(r.cur?.lg || '')) add(r.nid, 'draftees');
  // 3. Czech and Slovak prospects of the 32 clubs
  let pros = 0;
  for (const t of NHL_TEAMS) {
    try { const j = await retry(() => getJ(`https://api-web.nhle.com/v1/prospects/${t}`), 2, { base: 800 }); for (const grp of ['forwards', 'defensemen', 'goalies']) for (const q of j[grp] || []) if (['CZE', 'SVK'].includes(q.birthCountry)) { add(q.id, 'prospects'); pros++; } }
    catch (e) { notes.push(`prospects ${t}: ${e.message}`); }
  }
  // 4. career files
  for (const nid of opts.careers || []) add(nid, 'careers');
  // 5. ids seen in Czechia before
  const S = ls.get('ws.czech.ids', { m: {} }); // m: { nid: { n, seen: date | null, how } }
  for (const [nid, v] of Object.entries(S.m)) add(nid, v.how || 'kept');
  // player pages, six at a time
  const list = [...pool.keys()]; const rows = []; let k = 0, fails = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (k < list.length) {
      const nid = list[k++];
      let d; try { d = await retry(() => getJ(`https://api-web.nhle.com/v1/player/${nid}/landing`), 3, { base: 800 }); } catch (e) { if (!e.noRetry) fails++; continue; }
      const cz = (d.seasonTotals || []).filter(s => s.season === season && s.gameTypeId === 2 && s.leagueAbbrev === CZ_LG);
      const name = `${d.firstName?.default || ''} ${d.lastName?.default || ''}`.trim();
      if (!cz.length) { if (S.m[nid] && !S.m[nid].seen) S.m[nid].n = name; continue; }
      S.m[nid] = { n: name, seen: today, how: S.m[nid]?.how || pool.get(nid) };
      const sum = f => cz.reduce((a, s) => a + (+s[f] || 0), 0);
      const team = fixMoji(cz[cz.length - 1].teamName?.default || '');
      const base = { sid: 'CZN' + nid, first: d.firstName?.default || '', last: d.lastName?.default || '', team, dob: d.birthDate || undefined, gp: sum('gamesPlayed') };
      if (d.position === 'G') {
        const gp = base.gp; const ga = cz.reduce((a, s) => a + (+s.goalsAgainstAvg || 0) * (+s.gamesPlayed || 0), 0); const sv = cz.reduce((a, s) => a + (+s.savePctg || 0) * (+s.gamesPlayed || 0), 0);
        rows.push({ goalie: 1, ...base, pos: 'G', w: sum('wins'), gaa: gp ? (ga / gp).toFixed(2) : '', svp: gp && sv ? (sv / gp).toFixed(3) : '', min: '' });
      } else rows.push({ ...base, pos: d.position === 'D' ? 'D' : 'F', g: sum('goals'), a: sum('assists'), pts: sum('points'), ppp: null });
    }
  }));
  // forget ids not seen in Czechia for 60 days (seeds that never showed a line are kept 60 days from when they were added)
  for (const [nid, v] of Object.entries(S.m)) { const ref = v.seen || v.added; if (ref && (Date.parse(today) - Date.parse(ref)) / 864e5 > 60) delete S.m[nid]; else if (!ref) v.added = today; }
  ls.set('ws.czech.ids', { d: today, m: S.m });
  if (fails > list.length * 0.2) throw new Error(`Czech: ${fails} of ${list.length} NHL player pages failed`);
  notes.push(`from NHL player pages: ${rows.length} players in Czechia among ${list.length} NHL ids checked${fails ? `, ${fails} pages failed` : ''}; players without an NHL id (undrafted) are not covered`);
  rows.notes = notes;
  return rows;
}
