import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npm, ['test'], { stdio: ['inherit', 'pipe', 'pipe'], env: process.env });
const tail = [];
function consume(chunk, stream) {
  stream.write(chunk);
  const text = String(chunk);
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    tail.push(line);
    if (tail.length > 60) tail.shift();
  }
}
child.stdout.on('data', (chunk) => consume(chunk, process.stdout));
child.stderr.on('data', (chunk) => consume(chunk, process.stderr));
const code = await new Promise((resolve) => child.on('close', resolve));
if (code !== 0) {
  const message = tail.join('\n').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error(`::error title=npm test failure::${message}`);
  process.exit(code || 1);
}
