// Look up Fantrax players by id: name, NHL team (rights), position and league status. Reads data/adhoc/lookup-in.json
// (an array of ids), writes data/adhoc/lookup.json: { at, <id>: { name, team, position, eligiblePos, status }, ... }.
import { readJSON, writeJSON } from '../lib/config.js';
import { getLeagueInfo, getPlayerIds } from '../lib/fantrax.js';

const want = readJSON('data/adhoc/lookup-in.json');
if (!Array.isArray(want)) throw new Error('data/adhoc/lookup-in.json must be an array of Fantrax ids');
const ids = await getPlayerIds(); // both calls check the HTTP status and retry
const pi = (await getLeagueInfo()).playerInfo || {};
const out = { at: new Date().toISOString(), ...Object.fromEntries(want.map(id => [id, { ...(ids[id] || {}), ...(pi[id] || {}) }])) };
writeJSON('data/adhoc/lookup.json', out, 1);
console.log(want.length, 'ids,', want.filter(id => !ids[id]).length, 'unknown');
