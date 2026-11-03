// Installs server and dashboard dependencies. Newer npm refuses a nested install when the user-level config
// sets allow-scripts (the value is passed down as npm_config_allow_scripts), so that one variable is dropped here.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
delete env.npm_config_allow_scripts;
for (const dir of ['server', 'dashboard']) {
  const r = spawnSync('npm install --no-audit --no-fund', { cwd: path.join(root, dir), env, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status || 1);
}
