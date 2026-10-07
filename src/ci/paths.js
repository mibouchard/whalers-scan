import os from 'node:os';
import path from 'node:path';
// where src/ci/step.js leaves each step's result for src/ci/health.js (the runner's temp folder: never committed)
export const healthDirOf = () => process.env.HEALTH_DIR || path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'whalers-health');
