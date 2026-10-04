// Look up Fantrax players by id: name, NHL team (rights), position and league status. Reads data/adhoc/lookup-in.json
// (an array of ids), writes data/adhoc/lookup.json.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env.js';
const j = u => fetch(u).then(r => r.json());
const want = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'adhoc', 'lookup-in.json'), 'utf8'));
const ids = await j('https://www.fantrax.com/fxea/general/getPlayerIds?sport=NHL');
const pi = (await j('https://www.fantrax.com/fxea/general/getLeagueInfo?leagueId=fs61ldkdmow7aw2h')).playerInfo || {};
const out = Object.fromEntries(want.map(id => [id, { ...(ids[id] || {}), ...(pi[id] || {}) }]));
fs.writeFileSync(path.join(ROOT, 'data', 'adhoc', 'lookup.json'), JSON.stringify(out, null, 1));
console.log(Object.keys(out).length);
