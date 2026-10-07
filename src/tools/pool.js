// Daily player pool for the Front Office, so the page's built-in snapshot only has to hold things that don't change
// (projections, prospect tiers, the NHL schedule). Writes data/pool.json:
//   { at, status: { asOf, src, rows: { <fantraxId>: 'WW' } }   (players on waivers; everyone not rostered is otherwise a free agent),
//     injuries: { asOf, src, rows: { <fantraxId>: [injury, status text, updated 'Mon D', expected return 'YYYY-MM-DD' or ''] } } | null,
//     notes: [ ...anything that failed ] }
// Injuries come from ESPN's NHL injury report, matched to Fantrax ids by name and NHL club. Each part is optional.
// Salaries of unrostered players are NOT here: Fantrax only serves them to a logged-in browser (its public feed carries
// salaries for rostered players only, which data/league.json has).
import { readJSON, writeJSON } from '../lib/config.js';
import { getLeagueInfo, getPlayerIds } from '../lib/fantrax.js';
import { getJSONr as j } from '../lib/util.js';
import { makeMatcher, fold } from '../lib/names.js';

const norm = s => fold(s).split(' ').sort().join(' ');
const now = new Date().toISOString();
const out = { at: now, status: null, injuries: null, notes: [] };

// Fantrax ids, names and clubs. A name shared by two players only matches the one on the injured player's NHL club.
const ids = await getPlayerIds();
const M = makeMatcher(ids);
const fxFor = (name, team) => { const i = name.indexOf(' '); return M.find({ first: i < 0 ? '' : name.slice(0, i), last: i < 0 ? name : name.slice(i + 1), team }, { strict: true })?.id || null; };

// Waiver status
try {
  const info = await getLeagueInfo();
  const rows = {};
  for (const [id, v] of Object.entries(info.playerInfo || {})) if (v.status === 'WW') rows[id] = 'WW';
  out.status = { asOf: now, src: 'Fantrax league feed', rows };
} catch (e) { out.notes.push('status: ' + e.message); }

// Injuries (ESPN)
try {
  const st = await j('https://api-web.nhle.com/v1/standings/now');
  const abbr = {}; for (const t of st.standings || []) { abbr[norm(t.teamName?.default + '')] = t.teamAbbrev?.default; abbr[norm((t.placeName?.default || '') + ' ' + (t.teamCommonName?.default || ''))] = t.teamAbbrev?.default; }
  const inj = await j('https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries');
  const rows = {}; let miss = 0;
  const md = s => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Toronto' }); };
  for (const team of inj.injuries || []) {
    const ta = abbr[norm(team.displayName || '')] || '';
    for (const x of team.injuries || []) {
      const name = x.athlete?.displayName; if (!name) continue;
      const id = fxFor(name, ta); if (!id) { miss++; continue; }
      const what = x.details?.type || x.type?.description || x.shortComment?.split(/[:.]/)[0] || 'Injury';
      const ret = (x.details?.returnDate || '').slice(0, 10);
      const status = (x.status || x.type?.description || '') + (ret ? ' until ' + md(ret + 'T12:00:00Z') : '');
      rows[id] = [what, status.trim(), md(x.date), ret];
    }
  }
  if (!Object.keys(rows).length) throw new Error('no injuries matched (' + miss + ' unmatched)');
  out.injuries = { asOf: now, src: 'ESPN', rows };
  if (miss) out.notes.push(`injuries: ${miss} players not matched to Fantrax`);
} catch (e) {
  out.notes.push('injuries: ' + e.message);
  // keep the last injury report we have (its asOf says how old it is) rather than publishing none
  const prev = readJSON('data/pool.json');
  if (prev?.injuries?.rows && Date.now() - Date.parse(prev.injuries.asOf) < 4 * 864e5) { out.injuries = prev.injuries; out.notes.push('injuries: carried from ' + prev.injuries.asOf); }
}

writeJSON('data/pool.json', out);
console.log('waivers', out.status ? Object.keys(out.status.rows).length : 'FAILED',
  '| injuries', out.injuries ? Object.keys(out.injuries.rows).length : 'FAILED', out.notes.length ? '| ' + out.notes.join('; ') : '');
