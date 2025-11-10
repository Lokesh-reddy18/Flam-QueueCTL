const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const CLI_PATH = path.join(__dirname, '..', 'src', 'cli.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function run(command) {
  return new Promise((resolve, reject) => {
    const full = `node ${JSON.stringify(CLI_PATH)} ${command}`;
    exec(full, (error, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (error && error.code !== 0 && stderr && !stdout) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function runBackground(command) {
  const args = [CLI_PATH, ...command.split(' ')];
  const child = spawn('node', args, {
    stdio: 'ignore',
    windowsHide: true,
    detached: false
  });
  return child;
}

async function enqueueJson(jobData) {
  const tmpFile = path.join(__dirname, `demo-job-${Date.now()}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(jobData));
  try {
    const escaped = JSON.stringify(tmpFile);
    await run(`enqueue ${escaped}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

async function main() {
  console.log(chalk.bold('\n=== QueueCTL Demo ===\n'));

  // Start workers (2)
  console.log(chalk.cyan('> node src/cli.js worker start --count 2'));
  const workers = runBackground('worker start --count 2');
  await sleep(1000);

  // Enqueue jobs
  console.log(chalk.cyan('> Enqueue echo Hello'));
  await enqueueJson({ command: 'echo Hello' });

  console.log(chalk.cyan('> Enqueue sleep 1'));
  const isWindows = process.platform === 'win32';
  // Use a cross-platform sleep
  const sleepCmd = isWindows ? 'powershell -Command "Start-Sleep -s 1"' : 'sleep 1';
  await enqueueJson({ command: sleepCmd });

  console.log(chalk.cyan('> Enqueue nonexistent-command with max_retries=2'));
  await enqueueJson({ command: 'nonexistent-command', max_retries: 2 });

  // Status and lists
  console.log(chalk.cyan('> node src/cli.js status'));
  await run('status');

  console.log(chalk.cyan('> node src/cli.js list --state completed'));
  await run('list --state completed');

  console.log(chalk.cyan('> node src/cli.js dlq list'));
  let dlqList = await run('dlq list');

  // Retry first DLQ job if any
  const lines = (dlqList.stdout || '').split('\n');
  const idLine = lines.find(l => l.trim() && !l.includes('Dead Letter Queue') && !l.startsWith('===') && !l.startsWith('  ') && l.includes(' - '));
  if (idLine) {
    const jobId = idLine.split(' - ')[0].trim();
    if (jobId) {
      console.log(chalk.cyan(`> node src/cli.js dlq retry ${jobId}`));
      await run(`dlq retry ${jobId}`);
    }
  }

  // Status
  console.log(chalk.cyan('> node src/cli.js status'));
  await run('status');

  // Stop workers
  console.log(chalk.cyan('> node src/cli.js worker stop'));
  await run('worker stop');

  // Ensure background handle cleaned
  try { workers.kill('SIGTERM'); } catch {}

  console.log(chalk.green('\n=== Finished ===\n'));
}

main().catch(err => {
  console.error(chalk.red('Demo error:'), err.message || err);
  process.exit(1);
});


