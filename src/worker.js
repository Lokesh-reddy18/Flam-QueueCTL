const { spawn } = require('child_process');
const storage = require('./storage');
const config = require('./config');
const Job = require('./job');
const fs = require('fs');
const path = require('path');

class Worker {
  constructor(workerId) {
    this.workerId = workerId;
    this.isRunning = false;
    this.currentJob = null;
    this.shouldStop = false;
  }

  async start() {
    this.isRunning = true;
    this.shouldStop = false;
    console.log(`Worker ${this.workerId} started`);
    
    while (this.isRunning && !this.shouldStop) {
      try {
        await this.processNextJob();
      } catch (error) {
        console.error(`Worker ${this.workerId} error:`, error.message);
      }
      
      // Small delay to prevent tight loop
      await this.sleep(1000);
    }
    
    console.log(`Worker ${this.workerId} stopped`);
  }

  async processNextJob() {
    // Get next pending job
    const job = storage.getNextPendingJob();
    
    if (!job) {
      // Check for failed jobs that are ready to retry
      const failedJobs = storage.getJobsByState('failed');
      const readyToRetry = failedJobs.find(j => {
        const jobObj = Job.fromJSON(j);
        return jobObj.canRetry() && jobObj.shouldRetryNow();
      });
      
      if (readyToRetry) {
        const jobObj = Job.fromJSON(readyToRetry);
        jobObj.state = 'pending';
        jobObj.updated_at = new Date().toISOString();
        storage.updateJob(jobObj);
        
        const pendingJob = storage.getNextPendingJob();
        if (pendingJob) {
          await this.executeJob(Job.fromJSON(pendingJob));
        }
      }
      return;
    }

    await this.executeJob(Job.fromJSON(job));
  }

  async executeJob(job) {
    this.currentJob = job;
    console.log(`Worker ${this.workerId} processing job ${job.id}: ${job.command}`);
    
    try {
      const success = await this.runCommand(job.command);
      
      if (success) {
        job.state = 'completed';
        job.updated_at = new Date().toISOString();
        job.error = null;
        storage.updateJob(job);
        console.log(`Worker ${this.workerId} completed job ${job.id}`);
      } else {
        // Job failed
        job.attempts += 1;
        job.updated_at = new Date().toISOString();
        
        if (job.attempts >= job.max_retries) {
          // Move to DLQ
          job.state = 'failed';
          job.error = 'Max retries exceeded';
          storage.moveToDLQ(job);
          console.log(`Worker ${this.workerId} moved job ${job.id} to DLQ`);
        } else {
          // Schedule retry with exponential backoff
          const backoffBase = config.get('backoffBase');
          job.next_retry_at = job.calculateNextRetry(backoffBase);
          job.state = 'failed';
          job.error = `Failed after ${job.attempts} attempt(s). Will retry at ${job.next_retry_at}`;
          storage.updateJob(job);
          console.log(`Worker ${this.workerId} failed job ${job.id} (attempt ${job.attempts}/${job.max_retries}). Next retry: ${job.next_retry_at}`);
        }
      }
    } catch (error) {
      console.error(`Worker ${this.workerId} error executing job ${job.id}:`, error.message);
      job.attempts += 1;
      job.updated_at = new Date().toISOString();
      job.error = error.message;
      
      if (job.attempts >= job.max_retries) {
        storage.moveToDLQ(job);
      } else {
        const backoffBase = config.get('backoffBase');
        job.next_retry_at = job.calculateNextRetry(backoffBase);
        job.state = 'failed';
        storage.updateJob(job);
      }
    } finally {
      this.currentJob = null;
    }
  }

  runCommand(command) {
    return new Promise((resolve) => {
      // Determine shell based on OS
      const isWindows = process.platform === 'win32';
      const shell = isWindows ? 'cmd.exe' : '/bin/sh';
      const shellFlag = isWindows ? '/c' : '-c';
      
      const child = spawn(shell, [shellFlag, command], {
        stdio: 'pipe',
        env: process.env
      });
      
      let stdout = '';
      let stderr = '';
      
      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      child.on('close', (code) => {
        // Exit code 0 means success
        resolve(code === 0);
      });
      
      child.on('error', (error) => {
        // Command not found or other execution error
        console.error(`Command execution error: ${error.message}`);
        resolve(false);
      });
    });
  }

  async stop() {
    this.shouldStop = true;
    console.log(`Worker ${this.workerId} stopping...`);
    
    // Wait for current job to finish (with timeout)
    let waitTime = 0;
    const maxWaitTime = 30000; // 30 seconds
    
    while (this.currentJob && waitTime < maxWaitTime) {
      await this.sleep(1000);
      waitTime += 1000;
    }
    
    this.isRunning = false;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Worker manager for multiple workers
class WorkerManager {
  constructor() {
    this.workers = [];
    this.pidFile = config.get('workers.pidFile');
  }

  start(count = 1) {
    // Check if workers are already running
    if (this.isRunning()) {
      console.log('Workers are already running');
      return;
    }

    // Save PID
    this.savePid();
    
    // Start workers
    for (let i = 0; i < count; i++) {
      const worker = new Worker(i + 1);
      this.workers.push(worker);
      worker.start().catch(err => {
        console.error(`Worker ${worker.workerId} error:`, err);
      });
    }
    
    console.log(`Started ${count} worker(s)`);
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
      this.stop().catch(err => {
        console.error('Error during shutdown:', err);
        process.exit(1);
      });
    });
    process.on('SIGTERM', () => {
      this.stop().catch(err => {
        console.error('Error during shutdown:', err);
        process.exit(1);
      });
    });
  }

  async stop() {
    console.log('Stopping workers...');
    
    // Stop all workers
    const stopPromises = this.workers.map(worker => worker.stop());
    await Promise.all(stopPromises);
    
    this.workers = [];
    this.removePid();
    
    console.log('All workers stopped');
    process.exit(0);
  }

  savePid() {
    try {
      fs.writeFileSync(this.pidFile, process.pid.toString());
    } catch (error) {
      console.error('Error saving PID:', error.message);
    }
  }

  removePid() {
    try {
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }
    } catch (error) {
      // Ignore
    }
  }

  isRunning() {
    try {
      if (fs.existsSync(this.pidFile)) {
        const pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'));
        // Check if process is still running
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          // Process doesn't exist, remove stale PID file
          this.removePid();
          return false;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  getWorkerCount() {
    return this.workers.length;
  }
}

module.exports = WorkerManager;

