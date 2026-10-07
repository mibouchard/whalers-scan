// Runs one step of the daily job and records how it went, for data/health.json.
//   node src/ci/step.js <name> <script.js> [args...]
// The script's output passes straight through. Afterwards <HEALTH_DIR>/<name>.txt holds "ok" or "ERR: <last error line>".
// The exit code is the script's, so a failed step shows as failed in the Actions log (the workflow continues past it).
// RUN_STEPS (set by src/ci/guard.js) names the steps to run; a step that is not listed does nothing and records nothing.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { healthDirOf } from './paths.js';

const [name, script, ...args] = process.argv.slice(2);
if (!name || !script) { console.error('usage: step.js <name> <script.js> [args...]'); process.exit(2); }
const wanted = (process.env.RUN_STEPS || 'all').trim().split(/\s+/);
if (!wanted.includes('all') && !wanted.includes(name)) { console.log(`${name}: not part of this run`); process.exit(0); }

const dir = healthDirOf(); fs.mkdirSync(dir, { recursive: true });
const record = text => fs.writeFileSync(path.join(dir, name + '.txt'), text);
record('ERR: started but did not finish'); // overwritten below; stays if the runner kills the job mid-step
const limitMin = +process.env.STEP_TIMEOUT_MIN || ({ scan: 32, fawatch: 16 }[name] || 6);
const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'inherit', 'pipe'] });
let tail = ''; child.stderr.on('data', d => { process.stderr.write(d); tail = (tail + d).slice(-4000); });
const timer = setTimeout(() => { tail += `\nError: step timed out after ${limitMin} minutes`; child.kill('SIGKILL'); }, limitMin * 60000);
child.on('close', (code, signal) => {
  clearTimeout(timer);
  if (code === 0) { record('ok'); process.exit(0); }
  const lines = tail.split('\n').map(s => s.trim()).filter(Boolean);
  const msg = [...lines].reverse().find(l => /^([A-Za-z]*Error|AggregateError)\b.*:/.test(l)) || [...lines].reverse().find(l => !/^at |^\^|^node:|^Node\.js|^}$|^\[|^\{/.test(l)) || '';
  record(`ERR: ${(msg.replace(/^Error: /, '') || `exit code ${code ?? signal}`).slice(0, 240)}`);
  process.exit(code || 1);
});
