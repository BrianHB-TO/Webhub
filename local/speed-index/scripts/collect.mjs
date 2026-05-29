import { spawn } from 'node:child_process';

const commands = [
  ['npm', ['run', 'collect:crux']],
  ['npm', ['run', 'collect:lighthouse']]
];

for (const [command, args] of commands) {
  await run(command, args);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
      }
    });
    child.on('error', reject);
  });
}
