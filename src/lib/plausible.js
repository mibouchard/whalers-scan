// Cross-league plausibility check for Fantrax matches.
//
// Matching is by name, and a name can belong to two people. Two things catch that after every league has been read:
//
// 1. The Fantrax id cohort. Fantrax hands out ids in order, so players with neighbouring ids entered its database at
//    about the same time (mostly a draft class). From every row with a real birthdate the scan learns, per block of ids,
//    which birth years belong there (state/ws.idcohort.json). A 17-year-old in the OHL matched to an id from a block of
//    30-year-olds is a namesake; a row with no age matched to such an id is at least not an under-24 target.
// 2. One id in several leagues. A player can really be in two leagues of the same system in one season (NHL/AHL/ECHL,
//    KHL/VHL/MHL, SHL/Allsvenskan/J20) and can move from junior or college to pro, but then the ages agree. Rows that
//    cannot be the same person are namesakes: the best-supported row stays and the others lose the match; when no row is
//    clearly the real one, all of them are tagged 'amb' (ambiguous) and kept out of the free-agent lists.
//
// Works on plain records so the same code checks fresh rows from the engine and rows parsed back out of a saved
// latest.json (carried leagues, --retry-failed merges, the offline test):
//   { lg, fx, name, team, g ('F'|'D'|'G'|''), age, ak ('dob'|'est'|''), by (birth year), dob, gp, org, ref }
import { posGroup } from './names.js';

export const FAMILIES = [['NHL', 'AHL', 'ECHL'], ['KHL', 'VHL', 'MHL'], ['SHL', 'Allsvenskan', 'J20'], ['Liiga']];
// oldest a player can be in an age-limited league (overagers included)
export const LEAGUE_MAX_AGE = { OHL: 21, WHL: 21, QMJHL: 21, USHL: 21, MHL: 21, J20: 21, NCAA: 26 };
// leagues whose ages come from real birthdates (used for saved rows written before the `ak` column existed)
export const DOB_LEAGUES = new Set(['NHL', 'AHL', 'ECHL', 'OHL', 'WHL', 'QMJHL', 'USHL', 'Liiga', 'KHL', 'SHL']);
export const akFor = (lg, age) => age == null || age === '' ? '' : DOB_LEAGUES.has(lg) ? 'dob' : 'est';
const family = lg => FAMILIES.findIndex(f => f.includes(lg));
const idNum = id => parseInt(id, 36);
const bucket = id => String(id).slice(0, 3);
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];

// ---- id cohort ----
// data = { '<first 3 chars of id>': [birth years...] }
export function makeCohort(data = {}) {
  const keys = Object.keys(data);
  // birth-year percentiles for the block around an id: { n, p10, p50, p90 } (p90 = the young edge), or null when too thin
  function stats(id) {
    if (!id) return null; const bn = parseInt(bucket(id), 36); if (isNaN(bn)) return null;
    const list = [...(data[bucket(id)] || [])];
    // a thin block borrows from its neighbours (ids are base 36, so the next block is the next number)
    for (let d = 1; d <= 4 && list.length < 12; d++) for (const n of [bn - d, bn + d]) { const k = n.toString(36).padStart(3, '0'); if (data[k]) list.push(...data[k]); }
    if (list.length < 8) return null;
    list.sort((x, y) => x - y);
    return { n: list.length, p10: pct(list, .1), p50: pct(list, .5), p90: pct(list, .9) };
  }
  return { data, stats, size: keys.reduce((s, k) => s + data[k].length, 0) };
}
// learn the cohort from records with real birth years; `base` (the saved cohort) fills blocks today's rows do not cover
export function learnCohort(recs, base = {}) {
  const fresh = {};
  for (const r of recs) if (r.fx && r.ak === 'dob' && r.by) (fresh[bucket(r.fx)] ||= []).push(r.by);
  const out = { ...base };
  for (const [k, v] of Object.entries(fresh)) {
    // enough fresh rows replace the block; a few are added to what is known
    let list = v.length >= 12 ? v : [...(base[k] || []), ...v];
    if (list.length > 80) { list.sort((a, b) => a - b); const step = list.length / 80; list = Array.from({ length: 80 }, (_, i) => list[Math.floor(i * step)]); }
    out[k] = list;
  }
  return out;
}

// ---- records ----
export function recFromRow(lg, r) {
  const dob = r.dob && r.ak === 'dob' ? String(new Date(r.dob).toISOString()).slice(0, 10) : null;
  return { lg, fx: r.fx || '', name: `${r.first} ${r.last}`.trim(), team: r.team || '', g: r.goalie ? 'G' : posGroup(r.pos), age: r.age ?? null, ak: r.ak || '', by: dob ? +dob.slice(0, 4) : null, dob, gp: +r.gp || 0, org: r.org || '', own: r.own || '', ref: r };
}
// rows of a saved document (latest.json shape) -> records. year = the document's year, to turn ages into birth years.
export function recsFromDoc(doc, skip = () => false) {
  const year = +String(doc.d || new Date().toISOString()).slice(0, 4); const month = +String(doc.d || '').slice(5, 7) || 10;
  const out = [];
  for (const [list, kind] of [['owned', 'sk'], ['avail', 'sk'], ['und', 'sk'], ['risers', 'sk'], ['goalies', 'g']]) {
    const cols = doc.cols?.[kind] || []; const ix = k => cols.indexOf(k);
    for (const s of doc[list] || []) {
      const v = s.split('|'); const lg = v[0]; if (skip(lg)) continue;
      const get = k => ix(k) >= 0 ? (v[ix(k)] ?? '') : '';
      const age = get('age') === '' ? null : +get('age');
      // rows written before the ak column existed (or padded from them): tell real ages from estimates by league
      const ak = get('ak') || akFor(lg, age);
      // a birthday falls before the scan date for most of the season's players from October on
      out.push({ lg, fx: get('fx'), name: get('name'), team: get('team'), g: kind === 'g' ? 'G' : posGroup(get('pos')), age, ak, by: ak === 'dob' && age != null ? year - age - (month < 7 ? 1 : 0) : null, dob: null, gp: +get('gp') || 0, org: '', own: get('own'), ref: { list, s } });
    }
  }
  return out;
}

// ---- the check ----
// can the two rows be the same person?
function compatible(a, b) {
  if (a.g && b.g && a.g !== b.g) return false;
  const sameFam = family(a.lg) >= 0 && family(a.lg) === family(b.lg);
  const aK = a.ak === 'dob', bK = b.ak === 'dob';
  if (aK && bK) {
    if (a.dob && b.dob) return a.dob === b.dob;
    // saved rows only carry whole ages: allow the birthday to fall between two leagues of one system
    return sameFam && a.lg !== b.lg ? Math.abs(a.by - b.by) <= 1 : a.age === b.age;
  }
  // one real age: the other row's league must be able to hold a player that old, and an estimate must be close
  const known = aK ? a : bK ? b : null, other = aK ? b : a;
  if (known) {
    const max = LEAGUE_MAX_AGE[other.lg]; if (max && known.age > max + 1) return false;
    if (other.ak === 'est' && other.age != null && Math.abs(known.age - other.age) > 3) return false;
  }
  if (a.lg === b.lg) return !known; // two rows of one league with no birthdates: a player who changed clubs
  return sameFam; // across systems only matching birthdates prove it is one person
}

// opts: { cohort (makeCohort), year, fxGroup(id) -> 'F'|'D'|'G'|'' (Fantrax's own position, when known) }
// Marks records: rec.drop = reason (lose the match), rec.amb = true, rec.vet = minimum age (no age, veteran id block).
export function crossCheck(recs, opts = {}) {
  const year = opts.year || new Date().getUTCFullYear(); const cohort = opts.cohort || makeCohort({});
  const rep = { dropped: [], ambiguous: [], veteran: [] };
  const tag = r => `${r.lg}|${r.fx}|${r.name}|${r.team}`;
  const drop = (r, why) => { if (!r.drop) { r.drop = why; rep.dropped.push(`${tag(r)}|${why}`); } };
  const live = recs.filter(r => r.fx);
  // 1. each row against Fantrax's position and its id cohort
  for (const r of live) {
    const fg = opts.fxGroup ? opts.fxGroup(r.fx) : '';
    if (fg && r.g && fg !== r.g) { drop(r, `position: ${r.lg} lists ${r.g}, Fantrax ${fg}`); continue; }
    const st = cohort.stats(r.fx); if (!st) continue;
    const minAge = year - st.p90 - 1; r.cohort = st;
    if (r.ak === 'dob' && r.by > st.p90 + 4) { drop(r, `born ${r.by}, but this Fantrax id belongs with players born ${st.p10}-${st.p90}`); continue; }
    const max = LEAGUE_MAX_AGE[r.lg];
    if (r.ak !== 'dob' && max && minAge > max + 1) { drop(r, `no birthdate, and this Fantrax id belongs with players aged ${minAge}+ (${r.lg} tops out at ${max})`); continue; }
    if (r.ak === '' && minAge > 24) { r.vet = minAge; rep.veteran.push(`${tag(r)}|no age; Fantrax id belongs with players aged ${minAge}+`); }
  }
  // 2. one Fantrax id in more than one place
  const groups = {};
  for (const r of live) if (!r.drop) (groups[r.fx] ||= []).push(r);
  for (const g of Object.values(groups)) {
    // the same stat line can sit in several lists of a saved document
    const uniq = []; for (const r of g) { const u = uniq.find(x => x[0].lg === r.lg && x[0].team === r.team && x[0].name === r.name); if (u) u.push(r); else uniq.push([r]); }
    if (uniq.length < 2) continue;
    const score = r => {
      let s = r.ak === 'dob' ? 1 : 0; const st = r.cohort;
      if (r.ak === 'dob' && st) s += r.by <= st.p90 ? 2 : r.by === st.p90 + 1 ? 1 : -2; // younger than the block's young edge is suspect; older is normal (late signings)
      if (r.lg === 'NHL' && r.org && r.org === r.team) s += 4; // the NHL club itself agrees with Fantrax
      return s;
    };
    const ranked = uniq.map(u => ({ u, r: u[0], s: score(u[0]) })).sort((a, b) => b.s - a.s || b.r.gp - a.r.gp);
    const anchor = ranked[0]; const out = ranked.slice(1).filter(x => !compatible(anchor.r, x.r));
    if (!out.length) continue;
    if (out[0].s >= anchor.s - 1) {
      // no row is clearly the real one
      for (const x of [anchor, ...out]) for (const r of x.u) { r.amb = true; }
      rep.ambiguous.push(`${anchor.r.fx}|${[anchor, ...out].map(x => `${x.r.lg} ${x.r.name} ${x.r.team}${x.r.age != null ? ' ' + x.r.age : ''}`).join(' vs ')}`);
    } else for (const x of out) for (const r of x.u) drop(r, `namesake: the Fantrax player is the ${anchor.r.lg} ${anchor.r.team} one${anchor.r.age != null ? ' (' + anchor.r.age + ')' : ''}`);
  }
  return rep;
}

// Apply the marks to a saved document: dropped rows leave every list; ambiguous rows get mq = 'amb' and, like veteran
// rows, leave the free-agent lists.
export function applyToDoc(doc, recs) {
  const marks = new Map(); for (const r of recs) if (r.ref && r.ref.s && (r.drop || r.amb || r.vet)) marks.set(r.ref.list + '\n' + r.ref.s, r);
  const setCol = (s, cols, k, val) => { const v = s.split('|'); const i = cols.indexOf(k); if (i < 0) return s; while (v.length < cols.length) v.push(''); v[i] = val; return v.join('|'); };
  for (const [list, kind] of [['owned', 'sk'], ['avail', 'sk'], ['und', 'sk'], ['risers', 'sk'], ['goalies', 'g']]) {
    const cols = doc.cols?.[kind] || []; const freeList = list !== 'owned';
    doc[list] = (doc[list] || []).flatMap(s => {
      const m = marks.get(list + '\n' + s); if (!m) return [s];
      if (m.drop) return [];
      const unowned = !s.split('|')[cols.indexOf('own')];
      if (freeList && unowned && (m.amb || m.vet)) return [];
      return [m.amb ? setCol(s, cols, 'mq', 'amb') : s];
    });
  }
  return doc;
}
