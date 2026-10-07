// Decides what a run of the daily workflow does. Writes `mode` to $GITHUB_OUTPUT and RUN_STEPS / RETRY_FAILED to $GITHUB_ENV.
//   full    everything (the outside timer's dispatch, or no good scan yet today)
//   retry   today's scan exists but something failed: re-read only the failed leagues (scan.js --retry-failed) and
//           re-run only the tool steps that failed
//   skip    today's scan finished with no failed leagues and no failed steps: nothing to do
//   debug   a manual run with league names: scan that subset only, write data/status-debug.json
// "Today" is the America/Toronto date, and the scan must be less than 20 hours old.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { torontoDate, readJSON } from '../lib/config.js';

export const TOOL_STEPS = ['form', 'pool', 'league', 'box', 'alertLate', 'fawatch', 'week'];
export function plan({ event, leagues, retry, status, health, now = new Date() }) {
  if (event === 'workflow_dispatch' && (leagues || '').trim()) return { mode: 'debug', steps: ['scan'] };
  if (event !== 'schedule' && !retry) return { mode: 'full', steps: ['all'] };
  const today = torontoDate(now);
  const fresh = status && status.at && !(status.subset || []).length && torontoDate(new Date(status.at)) === today && now - Date.parse(status.at) < 20 * 3600e3;
  if (!fresh) return { mode: 'full', steps: ['all'] };
  const failedLeagues = [...new Set([...Object.keys(status.errors || {}), ...Object.entries(status.status || {}).filter(([, v]) => /^(ERR|empty|partial|carried)/.test(v)).map(([k]) => k)])];
  // tool steps: the ones health.json marks failed; with no health.json from today, all of them
  const h = health && health.d === today ? health : null;
  const failedSteps = TOOL_STEPS.filter(s => !h || !h.steps || String(h.steps[s] || 'ERR').startsWith('ERR'));
  const scanAgain = failedLeagues.length > 0 || (h && String(h.steps?.scan || '').startsWith('ERR'));
  if (!scanAgain && !failedSteps.length) return { mode: 'skip', steps: [] };
  return { mode: 'retry', steps: [...(scanAgain ? ['scan'] : []), ...failedSteps], failedLeagues };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const p = plan({ event: process.env.EVENT || process.env.GITHUB_EVENT_NAME || 'workflow_dispatch', leagues: process.env.LEAGUES, retry: /^(1|true)$/i.test(process.env.RETRY || ''), status: readJSON('data/status.json'), health: readJSON('data/health.json') });
  console.log(`mode: ${p.mode}${p.steps.length ? ' | steps: ' + p.steps.join(' ') : ''}${p.failedLeagues?.length ? ' | failed leagues: ' + p.failedLeagues.join(' ') : ''}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `mode=${p.mode}\n`);
  if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `RUN_STEPS=${p.steps.join(' ') || 'none'}\nRETRY_FAILED=${p.mode === 'retry' ? '1' : ''}\nRUN_MODE=${p.mode}\n`);
}
