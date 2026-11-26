// Small shared helpers: retry with backoff, deadlines, JSON fetch.
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const errText = e => String(e?.message || e) + (e?.cause ? ' (' + (e.cause.code || e.cause.message || e.cause) + ')' : '');

// retry(fn, tries): runs fn(attempt) until it resolves; waits base * 2^attempt (+ jitter) between tries.
// opts.signal stops retrying once aborted; an error with .noRetry = true is thrown at once.
export async function retry(fn, tries = 3, opts = {}) {
  const base = opts.base ?? 1500; let last;
  for (let t = 0; t < tries; t++) {
    if (opts.signal?.aborted) throw last || new Error('aborted');
    try { return await fn(t); } catch (e) {
      last = e; if (e?.noRetry || t === tries - 1) break;
      if (opts.onRetry) opts.onRetry(e, t + 1);
      await sleep(base * 2 ** t + Math.random() * base);
    }
  }
  throw last;
}

// Run work(signal) with a time limit. On timeout the signal is aborted (so its fetches stop), the work gets a short grace
// period to unwind, and the returned promise rejects with "deadline".
export async function withDeadline(work, ms, label = 'task') {
  const ac = new AbortController(); let timer;
  const p = Promise.resolve().then(() => work(ac.signal));
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(new Error('deadline')); rej(new Error(`${label}: deadline of ${Math.round(ms / 1000)}s exceeded`)); }, ms); });
  try { return await Promise.race([p, timeout]); }
  catch (e) { if (ac.signal.aborted) await Promise.race([p.catch(() => { }), sleep(8000)]); throw e; }
  finally { clearTimeout(timer); }
}

export async function getJSON(u, o) {
  const r = await fetch(u, o);
  if (!r.ok) throw new Error(`${r.status} ${String(u).split('?')[0]}`);
  return r.json();
}
// getJSON with three tries
export const getJSONr = (u, o) => retry(() => getJSON(u, o), 3);

// The NHL stats reports (api.nhle.com/stats/rest) return at most 100 rows a request since Nov 20, 2026, whatever limit is
// asked (limit=-1 no longer returns everyone); the answer's "total" still gives the true row count. Read a report in
// pages of 100, in one fixed order, and treat a short or doubled read as a failure, so that a part of a report is never
// used as if it were the whole of it (data/fo/season.json held 100 skaters of 780 for six days while its step said ok).
//   url: the report's address with its cayenneExp filter and no limit, start or sort
export async function nhlReportRows(url, get = getJSONr) {
  const sep = url.includes('?') ? '&' : '?'; const what = String(url).split('?')[0].split('/').slice(-2).join('/');
  const rows = []; let total = null;
  for (let start = 0; total === null || start < total; start += 100) {
    const j = await get(`${url}${sep}limit=100&start=${start}&sort=playerId`);
    if (!Array.isArray(j?.data)) throw new Error(`NHL report ${what}: no data`);
    rows.push(...j.data);
    if (typeof j.total === 'number') total = j.total; else if (j.data.length < 100) total = rows.length;
    if (!j.data.length) break;
  }
  if (rows.length !== total) throw new Error(`NHL report ${what}: short read, ${rows.length} of ${total} rows`);
  if (new Set(rows.map(r => JSON.stringify(r))).size !== rows.length) throw new Error(`NHL report ${what}: a row came back twice`);
  return rows;
}
