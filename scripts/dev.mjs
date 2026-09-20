import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  spawn(npm, ['run', 'dev'], { cwd: path.join(root, 'backend'), stdio: 'inherit' }),
  spawn(npm, ['run', 'start'], { cwd: path.join(root, 'frontend'), stdio: 'inherit' }),
];

let stopping = false;
function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal));
}

for (const child of children) {
  child.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
    stop();
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    process.exitCode = code ?? (signal ? 1 : 0);
    stop();
  });
}
