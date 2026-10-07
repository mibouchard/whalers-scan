// The HFD roster for the current and next scoring period, with names, NHL team, position, status and salary, plus counts
// and cap (active + reserve + dead cap). Writes data/adhoc/hfd-roster.json. (data/league.json has the same for every team.)
import { TEAM_ID, MY, writeJSON } from '../lib/config.js';
import { getPlayerIds, rosterBundle, rosterRows, capOf } from '../lib/fantrax.js';

const ids = await getPlayerIds();
const ro = await rosterBundle();
const rows = x => rosterRows(x, TEAM_ID, ids).map(({ elig, ...r }) => r);
const out = { at: new Date().toISOString(), period: ro.period, nextPeriod: ro.nextPeriod, current: rows(ro.cur), next: rows(ro.next || ro.cur), notes: ro.notes };
const count = r => r.reduce((m, x) => (m[x.status] = (m[x.status] || 0) + 1, m), {});
out.counts = { current: count(out.current), next: count(out.next) };
const cap = x => capOf(x?.rosters[TEAM_ID]?.rosterItems || [], MY);
out.cap = { current: cap(ro.cur), next: cap(ro.next || ro.cur) };
writeJSON('data/adhoc/hfd-roster.json', out, 1);
console.log(out.counts, 'room next', out.cap.next.room);
