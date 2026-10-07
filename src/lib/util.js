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
