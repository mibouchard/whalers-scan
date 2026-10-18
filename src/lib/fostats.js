// Shared by the two tools that feed the Front Office player card (src/tools/careers.js and src/tools/stats.js).
//   careers  past seasons, season by season, for every player the league can see (rebuilt by hand once a season)
//   stats    this season's NHL totals and each player's last games (rebuilt every morning)
// Both key players by Fantrax id. The page finds a player's careers file with chunkOf(), so the two must agree.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJSON } from './config.js';
import { getJSONr } from './util.js';

export const CHUNKS = 8;
// Which careers file holds a Fantrax id: the sum of its character codes, modulo CHUNKS (the page does the same sum).
export const chunkOf = fx => [...String(fx)].reduce((s, c) => s + c.charCodeAt(0), 0) % CHUNKS;
export const careersPath = k => `data/fo/careers-${k}.json`;   // relative to the repo root, as readJSON and writeJSON take it

// Fantrax id -> NHL id from the careers files already in the repo (empty when they have not been built yet)
export function careersNid() {
  const m = {};
  for (let k = 0; k < CHUNKS; k++) { const c = readJSON(careersPath(k)); for (const [fx, p] of Object.entries(c?.p || {})) if (p.nid) m[fx] = p.nid; }
  return m;
}
// Fantrax id -> NHL id from the dated box files (box.js writes nid on every row)
export function boxNid() {
  const m = {}; const dir = path.join(ROOT, 'data', 'adhoc');
  for (const f of fs.readdirSync(dir).filter(f => /^box-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()) for (const r of readJSON('data/adhoc/' + f)?.rows || []) if (r.fx && r.nid) m[r.fx] = r.nid;
  return m;
}

// NHL stats REST reports (api.nhle.com): every player in one call per season.
//   report: 'skater/summary', 'skater/realtime', 'goalie/summary'; season: '20262027'
const REST = 'https://api.nhle.com/stats/rest/en/';
export async function report(kind, season) {
  const j = await getJSONr(`${REST}${kind}?limit=-1&cayenneExp=${encodeURIComponent(`seasonId=${season} and gameTypeId=2`)}`);
  if (!Array.isArray(j.data)) throw new Error(`${kind} ${season}: no data`);
  return j.data;
}
// The same player can have one row per club in a season: add them up per player id
export function byPlayer(rows, pick) {
  const m = {};
  for (const r of rows) { const o = m[r.playerId] ||= {}; for (const [k, v] of Object.entries(pick(r))) o[k] = typeof v === 'number' ? (o[k] || 0) + v : (o[k] ?? v); }
  return m;
}
