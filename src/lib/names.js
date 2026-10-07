// The one name normaliser. Everything that compares a player name from one source with a name from another goes through
// here: the scan engine (league sites -> Fantrax) and the NHL tools (NHL API -> Fantrax).
//
//   fold(s)            accents and apostrophes stripped, lower case, letters and single spaces only
//   nameKey(f, l)      exact key: folded first + last name with spaces removed, in order ("Jean-Luc Foudy" = "Jean Luc Foudy",
//                      "O'Reilly" = "OReilly"; "Ryan James" != "James Ryan"; "Henry" != "Henri")
//   rusKey(f, l)       loose key for names transliterated from Russian (KHL, VHL, MHL only): spelling variants collapse
//                      (Dmitry/Dmitri, Yegor/Egor, Alexei/Aleksei) and word order is ignored
//   rusOrderedKey      the same spelling fold with word order kept: the fallback for a Russian given name in any other
//                      league (an OHL "Artem" is Fantrax's "Artyom"), used only when isRussianFirst(first) is true
//   makeMatcher(ids)   NHL player -> Fantrax id, by full name, then by last name + NHL team; keeps an `unmatched` list
const SPECIAL = { ø: 'o', Ø: 'O', æ: 'ae', Æ: 'AE', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ß: 'ss' };
export const fold = s => String(s ?? '').replace(/[øØæÆłŁđĐß]/g, c => SPECIAL[c]).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/['’‘`.]/g, '').toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
export const nameKey = (first, last) => fold((first || '') + ' ' + (last || '')).replace(/ /g, '');
export const rusCanon = t => t.replace(/x/g, 'ks').replace(/^ye/, 'e').replace(/yo/g, 'e').replace(/(ey|ei|ii|iy|yi|ij|y)$/, 'i');
export const rusKey = (first, last) => fold((first || '') + ' ' + (last || '')).split(' ').filter(Boolean).map(rusCanon).sort().join(' ');

export const rusOrderedKey = (first, last) => fold((first || '') + ' ' + (last || '')).split(' ').filter(Boolean).map(rusCanon).join('');
// Russian given names whose Latin spelling varies from site to site (in their folded form)
const RUS_FIRST = new Set(['dmitri', 'aleksei', 'andrei', 'sergei', 'matvei', 'timofei', 'nikolai', 'vasili', 'arseni', 'evgeni', 'egor', 'artem', 'semen', 'fedor', 'petr', 'grigori', 'georgi', 'anatoli', 'vitali', 'valeri', 'yuri', 'gennadi', 'arkadi', 'maksim', 'aleksi', 'savveli', 'saveli']);
export const isRussianFirst = first => RUS_FIRST.has(rusCanon(fold(first).split(' ')[0] || ''));
export const lastTeamKey = (last, team) => fold(last).replace(/ /g, '') + '|' + (team || '');

// Fantrax names are "Last, First"
export const fxSplit = name => { const i = String(name || '').indexOf(', '); return i < 0 ? ['', String(name || '')] : [name.slice(i + 2), name.slice(0, i)]; };
export const fxDisplay = name => { const [f, l] = fxSplit(name); return f ? f + ' ' + l : l; };

// Position group: 'G', 'D', 'F' or '' when unknown. posGroup works on a single position from a league site;
// fxGroup on Fantrax's position list and returns '' when the player is eligible at both forward and defence.
export const posGroup = pos => { const p = String(pos || '').toUpperCase(); return !p ? '' : /G/.test(p) ? 'G' : /D/.test(p) ? 'D' : /[CLRWF]/.test(p) ? 'F' : ''; };
export function fxGroup(...lists) {
  const set = new Set(lists.filter(Boolean).join(',').split(',').map(s => s.trim()).filter(Boolean).map(p => p === 'G' ? 'G' : p === 'D' ? 'D' : /^(C|LW|RW|F|W)$/.test(p) ? 'F' : ''));
  set.delete(''); return set.size === 1 ? [...set][0] : '';
}

// NHL player -> Fantrax id. ids = getPlayerIds response ({ id: { name: 'Last, First', team, position } }).
export function makeMatcher(ids) {
  const byKey = {}, byLastTeam = {};
  for (const [id, p] of Object.entries(ids || {})) {
    const [f, l] = fxSplit(p.name); const c = { id, team: p.team || '', pos: p.position || '', first: fold(f) };
    (byKey[nameKey(f, l)] ||= []).push(c);
    (byLastTeam[fold(l).replace(/ /g, '') + '|' + c.team] ||= []).push(c);
  }
  const unmatched = [];
  // q: { first, last, team (NHL abbrev), pos ('C','L','R','D','G'), goalie }
  // opts.strict: with several namesakes and none on q.team, give up instead of picking one
  function find(q, opts = {}) {
    const isG = !!q.goalie || q.pos === 'G';
    const cls = q.goalie == null && !q.pos ? () => true : c => /G/.test(c.pos) === isG; // class unknown: any
    let how = 'name', cands = (byKey[nameKey(q.first, q.last)] || []).filter(cls);
    if (!cands.length && q.team) {
      how = 'last+team';
      cands = (byLastTeam[fold(q.last).replace(/ /g, '') + '|' + q.team] || []).filter(cls);
      // two brothers on one club: the first initial has to agree, and then only one may be left
      if (cands.length > 1) { const ini = fold(q.first)[0]; cands = ini ? cands.filter(c => c.first[0] === ini) : []; }
      if (cands.length > 1) { const g = posGroup(q.pos); cands = cands.filter(c => fxGroup(c.pos) === g); if (cands.length !== 1) cands = []; }
    }
    let c = null;
    if (cands.length === 1) c = cands[0];
    else if (cands.length > 1) {
      // namesakes: same NHL club first, then the same position group, then the one with no club
      const g = posGroup(q.pos); const same = cands.filter(x => x.team === q.team);
      c = (same.length > 1 ? same.find(x => fxGroup(x.pos) === g) : null) || same[0] || null;
      if (!c && !opts.strict) c = cands.find(x => fxGroup(x.pos) === g && (!x.team || x.team === '(N/A)')) || cands.find(x => !x.team || x.team === '(N/A)') || cands[0];
    }
    if (!c) { unmatched.push(`${q.first ? q.first + ' ' : ''}${q.last}${q.team ? ' ' + q.team : ''}`); return null; }
    return { id: c.id, how };
  }
  return { find, unmatched, byKey };
}
