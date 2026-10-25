// Runs the project venv's Python on any OS, e.g. `npm run build-roads -- --rebuild`.
import { spawnSync } from 'node:child_process';
import { pythonPath } from './simulation.mjs';

const result = spawnSync(pythonPath(), process.argv.slice(2), { stdio: 'inherit' });
if (result.error) console.error(`Could not run ${pythonPath()}: ${result.error.message}. See README "Simulation setup".`);
process.exit(result.status ?? 1);
