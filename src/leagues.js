// League adapters that the browser scan ran as site "collectors". Each returns rows in the engine's shape:
// skater {sid, first, last, pos, team, gp, g, a, pts, ppp, dob?, age?, prev?, toi?}; goalie {goalie: 1, sid, first, last, pos: 'G', team, gp, svp, gaa, w, min, dob?, age?}.
// Season ids that change yearly are constants at the top.
import vm from 'node:vm';
import { realFetch, UA, sleep, parseHTML, cookieHeader } from './env.js';

export const SEASON = {
  KHL: { season: 's19', tour: '1436' },          // en.khl.ru/stat/players/1436/
  SHL: 'qa98unlbd6',                              // ssgtUuid on shl.se/game-stats/players
  SWE: { Allsvenskan: [20962], J20: [20963, 20964] }, // stats.swehockey.se event ids
  CZ: { season: 2026, comp: 7562 },               // hokej.cz Tipsport extraliga
};

const num = x => { const v = parseFloat(String(x ?? '').replace(',', '.')); return isNaN(v) ? 0 : v; };
const text = async (u, o) => { const r = await fetch(u, o); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.text(); };
const json = async (u, o) => JSON.parse(await text(u, o));
const splitFirst = s => { s = s.replace(/ /g, ' ').trim(); const i = s.indexOf(' '); return i < 0 ? ['', s] : [s.slice(0, i), s.slice(i + 1)]; };

// ---------- KHL (en.khl.ru) ----------
// Reuses the engine's WS.khl() adapter: it calls BX.bitrix_sessid() and relative /rest/ URLs, so give it a session token
// from the stats page and route /rest/ calls to the site with that session's cookie, one at a time (the site answers
// parallel calls with an HTML error page) and with retries.
export async function khl(WS) {
  const page = await realFetch(`https://en.khl.ru/stat/players/${SEASON.KHL.tour}/`, { headers: UA, signal: AbortSignal.timeout(60000) });
  const html = await page.text();
  const sess = (html.match(/bitrix_sessid['"]\s*:\s*['"]([0-9a-f]+)['"]/) || [])[1];
  if (!sess) throw new Error('KHL: no session token on the stats page');
  globalThis.BX = { bitrix_sessid: () => sess };
  const prev = globalThis.fetch; let q = Promise.resolve();
  globalThis.fetch = (u, o = {}) => {
    if (typeof u !== 'string' || !u.startsWith('/rest/')) return prev(u, o);
    const p = q.then(async () => {
      for (let t = 0; t < 6; t++) {
        const r = await realFetch('https://en.khl.ru' + u, { ...o, headers: { ...UA, ...(o.headers || {}), Cookie: cookieHeader('https://en.khl.ru/'), 'X-Requested-With': 'XMLHttpRequest', Referer: `https://en.khl.ru/stat/players/${SEASON.KHL.tour}/` }, signal: AbortSignal.timeout(60000) });
        const txt = await r.text();
        if (txt.trim().startsWith('{')) { await sleep(150); return new Response(txt, { status: 200, headers: { 'Content-Type': 'application/json' } }); }
        await sleep(1500 * (t + 1));
      }
      throw new Error('KHL: /rest/ kept returning non-JSON');
    });
    q = p.catch(() => { }); return p;
  };
  try { return await WS.khl(SEASON.KHL.season, SEASON.KHL.tour)(); } finally { globalThis.fetch = prev; }
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

// SHL (shl.se): full skater and goalie summaries with birthdates.
export async function shl() {
  const get = k => json(`https://www.shl.se/api/statistics-v2/stats-info/${k}?count=2000&ssgtUuid=${SEASON.SHL}&provider=statnet`, { headers: { Accept: 'application/json', Referer: 'https://www.shl.se/game-stats/players' } }).then(j => j[0].stats);
  const [sk, gk] = await Promise.all([get('players_summary'), get('goalkeepers_summary')]);
  const rows = sk.filter(s => s.info && s.info.position !== 'GK').map(s => ({ sid: s.info.uuid, first: s.info.firstName, last: s.info.lastName, pos: s.info.position, team: s.info.teamCode, gp: +s.GP, g: +s.G, a: +s.A, pts: +s.TP, ppp: null, dob: s.info.birthDate, toi: s.TOI_GP || '' }));
  gk.forEach(s => { if (s.info) rows.push({ goalie: 1, sid: s.info.uuid, first: s.info.firstName, last: s.info.lastName, pos: 'G', team: s.info.teamCode, gp: +s.GPI, svp: s.SVSPerc ? (parseFloat(s.SVSPerc) / 100).toFixed(3) : '', gaa: s.GAA, w: s.W, min: s.MIP, dob: s.info.birthDate }); });
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

// NCAA (collegehockeynews.com): every D1 skater, qualified goalies, last season's P/GP. Age estimated from class.
export async function ncaa(ls) {
  const AGE = { Fr: 19, So: 20, Jr: 21, Sr: 22, Gr: 23 };
  const parse = async u => [...parseHTML(await text('https://www.collegehockeynews.com' + u)).querySelectorAll('table tr')].map(trr => { const a = trr.querySelector('a[href*="/players/"]'); return { c: [...trr.children].map(x => x.textContent.replace(/ /g, ' ').trim()), id: a ? a.getAttribute('href').split('/').pop() : null }; }).filter(r => r.id && r.c.length > 10);
  const y = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  let P = ls.get('ws.prev.ncaa', null);
  if (!P || P.s !== y - 1) { P = { s: y - 1, m: {} }; (await parse(`/stats/overall.php?season=${y - 1}${y}`)).forEach(r => { const gp = +r.c[5]; if (gp >= 10) P.m[r.id] = +(+r.c[8] / gp).toFixed(2); }); ls.set('ws.prev.ncaa', P); }
  const rows = (await parse('/stats/overall.php')).map(r => { const [first, last] = splitFirst(r.c[1]); return { sid: r.id, first, last, pos: r.c[3], team: r.c[2], age: AGE[r.c[4]] ?? null, gp: +r.c[5], g: +r.c[6], a: +r.c[7], pts: +r.c[8], ppp: null, prev: P.m[r.id] ?? null, toi: r.c[18] || '' }; });
  (await parse('/stats/overall-goalie.php')).forEach(r => { const [first, last] = splitFirst(r.c[1]); rows.push({ goalie: 1, sid: r.id, first, last, pos: 'G', team: r.c[2], age: AGE[r.c[3]] ?? null, gp: +r.c[4], w: +r.c[5], min: r.c[9], gaa: r.c[10], svp: r.c[13] }); });
  return rows;
}

// Czech Extraliga (hokej.cz). Age bands from the site's U20/U24 filters: 19 / 22 / 25 (= 24+).
export async function czech() {
  const { season, comp } = SEASON.CZ;
  await fetch('https://www.hokej.cz/', { headers: { 'Accept-Language': 'cs-CZ,cs;q=0.9,en;q=0.8' } }).catch(() => { }); // pick up the site's cookies first
  const base = `https://www.hokej.cz/tipsport-extraliga/player-stats/detailni?stats-filter-season=${season}&stats-filter-competition=${comp}`;
  const trs = async u => { const d = parseHTML(await text(u)); const t = [...d.querySelectorAll('table')].pop(); return [...t.querySelectorAll('tbody tr')].map(trr => { const a = trr.querySelector('a[href*="/hrac/"]'); return { c: [...trr.children].map(x => x.textContent.trim()), id: a ? (a.getAttribute('href').match(/\/hrac\/[^/]+\/(\d+)/) || [])[1] : null }; }).filter(r => r.id); };
  const ids = async age => new Set((await trs(base + `&stats-playerFilter-age=${age}&do=stats-view-pager-all`)).map(r => r.id));
  const [all, u20, u24, gk] = await Promise.all([trs(base + '&do=stats-view-pager-all'), ids(20), ids(24), trs(`https://www.hokej.cz/tipsport-extraliga/stats-center?season=${season}&competition=${comp}&stranger=0&stats-section=goalkeeper`)]);
  const age = id => u20.has(id) ? 19 : u24.has(id) ? 22 : 25;
  const rows = all.map(r => { const [first, last] = splitFirst(r.c[1]); return { sid: 'CZ' + r.id, first, last, pos: r.c[3] === 'O' ? 'D' : 'F', team: r.c[2], age: age(r.id), gp: num(r.c[4]), g: num(r.c[5]), a: num(r.c[6]), pts: num(r.c[7]), ppp: null }; });
  gk.forEach(r => { const [first, last] = splitFirst(r.c[1]); rows.push({ goalie: 1, sid: 'CZ' + r.id, first, last, pos: 'G', team: r.c[2], age: age(r.id), gp: num(r.c[4]), min: r.c[5], w: num(r.c[9]), gaa: r.c[11], svp: r.c[12] ? (num(r.c[12]) / 100).toFixed(3) : '' }); });
  return rows;
}
