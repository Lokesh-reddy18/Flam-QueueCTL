#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const storage = require('./storage');
const config = require('./config');
const Job = require('./job');
const WorkerManager = require('./worker');

const program = new Command();

program
  .name('queuectl')
  .description('CLI-based background job queue system')
  .version('1.0.0');

// Enqueue command
program
  .command('enqueue')
  .description('Add a new job to the queue')
  .argument('[job-data]', 'Job data as JSON string (or pass via stdin)')
  .action((jobData) => {
    const fs = require('fs');
    
    // Handle job data from argument or stdin
    let jobDataString = jobData;
    
    // If no argument provided, try to read from stdin
    if (!jobDataString && !process.stdin.isTTY) {
      const chunks = [];
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => chunks.push(chunk));
      process.stdin.on('end', () => {
        jobDataString = chunks.join('');
        processJobData(jobDataString);
      });
      return;
    }
    
    // If argument is a file path, read from file
    if (jobDataString && fs.existsSync(jobDataString)) {
      try {
        jobDataString = fs.readFileSync(jobDataString, 'utf8');
      } catch (error) {
        console.error(chalk.red(`Error reading file: ${error.message}`));
        process.exit(1);
        return;
      }
    }
    
    if (!jobDataString) {
      console.error(chalk.red('Error: Job data is required. Provide JSON string as argument or via stdin.'));
      console.error(chalk.yellow('Example: node src/cli.js enqueue \'{"command":"echo hello"}\''));
      process.exit(1);
      return;
    }
    
    processJobData(jobDataString);
  });

function processJobData(jobDataString) {
  try {
    const data = JSON.parse(jobDataString);
    const job = new Job(data);
    
    // Validate required fields
    if (!job.command) {
      console.error(chalk.red('Error: Job must have a "command" field'));
      process.exit(1);
      return;
    }
    
    storage.addJob(job);
    console.log(chalk.green(`Job ${job.id} enqueued successfully`));
    console.log(JSON.stringify(job.toJSON(), null, 2));
  } catch (error) {
    console.error(chalk.red(`Error parsing JSON: ${error.message}`));
    console.error(chalk.yellow('Make sure your JSON is valid. Example:'));
    console.error(chalk.gray('  {"id":"job1","command":"echo hello"}'));
    process.exit(1);
  }
}

// Worker commands
const workerCmd = program
  .command('worker')
  .description('Manage worker processes');

workerCmd
  .command('start')
  .description('Start worker processes')
  .option('-c, --count <number>', 'Number of workers to start', '1')
  .action((options) => {
    const count = parseInt(options.count, 10);
    if (isNaN(count) || count < 1) {
      console.error(chalk.red('Error: Count must be a positive number'));
      process.exit(1);
    }
    
    const workerManager = new WorkerManager();
    workerManager.start(count);
    
    // Keep process alive
    process.stdin.resume();
  });

workerCmd
  .command('stop')
  .description('Stop running workers gracefully')
  .action(() => {
    const fs = require('fs');
    const workerManager = new WorkerManager();
    const pidFile = config.get('workers.pidFile');
    
    if (!fs.existsSync(pidFile)) {
      console.log(chalk.yellow('No workers are currently running'));
      return;
    }
    
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8'));
      
      // Check if process is still running
      try {
        process.kill(pid, 0); // Signal 0 checks if process exists
      } catch (error) {
        // Process doesn't exist, remove stale PID file
        if (fs.existsSync(pidFile)) {
          fs.unlinkSync(pidFile);
        }
        console.log(chalk.yellow('No workers are currently running (stale PID file removed)'));
        return;
      }
      
      // Send SIGTERM for graceful shutdown (works on Node.js 14+ on Windows too)
      try {
        process.kill(pid, 'SIGTERM');
        console.log(chalk.green('Stop signal sent to workers'));
        console.log(chalk.gray('Workers will finish current jobs and then stop gracefully'));
      } catch (error) {
        // If SIGTERM doesn't work, try SIGINT
        try {
          process.kill(pid, 'SIGINT');
          console.log(chalk.green('Stop signal (SIGINT) sent to workers'));
        } catch (err) {
          console.error(chalk.red(`Error stopping workers: ${err.message}`));
          console.log(chalk.yellow(`Try manually killing process ${pid} if it's still running`));
          process.exit(1);
        }
      }
    } catch (error) {
      console.error(chalk.red(`Error stopping workers: ${error.message}`));
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .description('Show summary of all job states & active workers')
  .action(() => {
    const stats = storage.getStats();
    const workerManager = new WorkerManager();
    const isRunning = workerManager.isRunning();
    
    console.log(chalk.bold('\n=== Queue Status ===\n'));
    console.log(`Pending:    ${chalk.yellow(stats.pending)}`);
    console.log(`Processing: ${chalk.blue(stats.processing)}`);
    console.log(`Completed:  ${chalk.green(stats.completed)}`);
    console.log(`Failed:     ${chalk.red(stats.failed)}`);
    console.log(`Dead (DLQ): ${chalk.red(stats.dead)}`);
    console.log(`\nWorkers:    ${isRunning ? chalk.green('Running') : chalk.gray('Stopped')}`);
    console.log();
  });

// List command
program
  .command('list')
  .description('List jobs by state')
  .option('-s, --state <state>', 'Filter by state (pending, processing, completed, failed, dead)', 'all')
  .action((options) => {
    let jobs = [];
    
    if (options.state === 'all') {
      jobs = storage.getAllJobs();
    } else if (options.state === 'dead') {
      jobs = storage.getDLQJobs();
    } else {
      jobs = storage.getJobsByState(options.state);
    }
    
    if (jobs.length === 0) {
      console.log(chalk.gray(`No jobs found with state: ${options.state}`));
      return;
    }
    
    console.log(chalk.bold(`\n=== Jobs (${options.state}) ===\n`));
    jobs.forEach(job => {
      const jobObj = Job.fromJSON(job);
      const stateColor = {
        pending: chalk.yellow,
        processing: chalk.blue,
        completed: chalk.green,
        failed: chalk.red,
        dead: chalk.red
      }[jobObj.state] || chalk.gray;
      
      console.log(`${stateColor(jobObj.state.padEnd(10))} ${jobObj.id} - ${jobObj.command}`);
      if (jobObj.error) {
        console.log(`           Error: ${jobObj.error}`);
      }
      if (jobObj.next_retry_at) {
        console.log(`           Next retry: ${jobObj.next_retry_at}`);
      }
    });
    console.log();
  });

// DLQ commands
const dlqCmd = program
  .command('dlq')
  .description('Manage Dead Letter Queue');

dlqCmd
  .command('list')
  .description('List all jobs in the Dead Letter Queue')
  .action(() => {
    const dlqJobs = storage.getDLQJobs();
    
    if (dlqJobs.length === 0) {
      console.log(chalk.gray('Dead Letter Queue is empty'));
      return;
    }
    
    console.log(chalk.bold('\n=== Dead Letter Queue ===\n'));
    dlqJobs.forEach(job => {
      const jobObj = Job.fromJSON(job);
      console.log(`${jobObj.id} - ${jobObj.command}`);
      console.log(`  Attempts: ${jobObj.attempts}/${jobObj.max_retries}`);
      console.log(`  Error: ${jobObj.error || 'N/A'}`);
      console.log(`  Created: ${jobObj.created_at}`);
      console.log();
    });
  });

dlqCmd
  .command('retry')
  .description('Retry a job from the Dead Letter Queue')
  .argument('<job-id>', 'Job ID to retry')
  .action((jobId) => {
    const job = storage.retryFromDLQ(jobId);
    
    if (!job) {
      console.error(chalk.red(`Job ${jobId} not found in DLQ`));
      process.exit(1);
    }
    
    console.log(chalk.green(`Job ${jobId} moved back to queue for retry`));
    console.log(JSON.stringify(job.toJSON(), null, 2));
  });

// Config commands
const configCmd = program
  .command('config')
  .description('Manage configuration');

configCmd
  .command('set')
  .description('Set a configuration value')
  .argument('<key>', 'Configuration key (e.g., max-retries, backoff-base)')
  .argument('<value>', 'Configuration value')
  .action((key, value) => {
    // Map CLI keys to config keys
    const keyMap = {
      'max-retries': 'maxRetries',
      'backoff-base': 'backoffBase'
    };
    
    const configKey = keyMap[key] || key;
    
    // Parse value
    let configValue = value;
    if (!isNaN(value)) {
      configValue = parseFloat(value);
    }
    
    config.set(configKey, configValue);
    console.log(chalk.green(`Configuration ${key} set to ${value}`));
  });

configCmd
  .command('get')
  .description('Get a configuration value')
  .argument('<key>', 'Configuration key')
  .action((key) => {
    const keyMap = {
      'max-retries': 'maxRetries',
      'backoff-base': 'backoffBase'
    };
    
    const configKey = keyMap[key] || key;
    const value = config.get(configKey);
    
    if (value === undefined) {
      console.error(chalk.red(`Configuration key ${key} not found`));
      process.exit(1);
    }
    
    console.log(`${key}: ${value}`);
  });

configCmd
  .command('list')
  .description('List all configuration values')
  .action(() => {
    const allConfig = config.getAll();
    console.log(chalk.bold('\n=== Configuration ===\n'));
    console.log(`max-retries: ${allConfig.maxRetries}`);
    console.log(`backoff-base: ${allConfig.backoffBase}`);
    console.log(`data-dir: ${allConfig.dataDir}`);
    console.log();
  });

// Parse arguments
program.parse();

// If no command provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}

