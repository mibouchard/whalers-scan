// Daily player pool for the Front Office, so the page's built-in snapshot only has to hold things that don't change
// (projections, prospect tiers, the NHL schedule). Writes data/pool.json:
//   { at, status: { asOf, src, rows: { <fantraxId>: 'WW' } }   (players on waivers; everyone not rostered is otherwise a free agent),
//     injuries: { asOf, src, rows: { <fantraxId>: [injury, status text, updated 'Mon D', expected return 'YYYY-MM-DD' or ''] } } | null,
//     notes: [ ...anything that failed ] }
// Injuries come from ESPN's NHL injury report, matched to Fantrax ids by name and NHL club. Each part is optional.
// Salaries of unrostered players are NOT here: Fantrax only serves them to a logged-in browser (its public feed carries
// salaries for rostered players, which the morning report's live rosters already refresh). Fred's Players export fills them.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env.js';

const L = 'fs61ldkdmow7aw2h';
const j = (u, o) => fetch(u, o).then(r => { if (!r.ok) throw new Error(r.status + ' ' + u); return r.json(); });
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['.\-]/g, '').toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
const now = new Date().toISOString();
const out = { at: now, status: null, injuries: null, notes: [] };

// Fantrax ids, names and clubs
const ids = await j('https://www.fantrax.com/fxea/general/getPlayerIds?sport=NHL');
const byName = {};
for (const [id, p] of Object.entries(ids)) {
  const [l, f] = (p.name || '').split(', ');
  const k = norm((f || '') + ' ' + (l || ''));
  (byName[k] = byName[k] || []).push({ id, team: p.team || '' });
}
const fxFor = (name, team) => { const c = byName[norm(name)] || []; return (c.find(x => x.team === team) || (c.length === 1 ? c[0] : null))?.id || null; };

// Waiver status
try {
  const info = await j(`https://www.fantrax.com/fxea/general/getLeagueInfo?leagueId=${L}`);
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
} catch (e) { out.notes.push('injuries: ' + e.message); }

fs.writeFileSync(path.join(ROOT, 'data', 'pool.json'), JSON.stringify(out));
console.log('waivers', out.status ? Object.keys(out.status.rows).length : 'FAILED',
  '| injuries', out.injuries ? Object.keys(out.injuries.rows).length : 'FAILED', out.notes.length ? '| ' + out.notes.join('; ') : '');
