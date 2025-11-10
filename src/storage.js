const fs = require('fs');
const path = require('path');
const config = require('./config');

const JOBS_FILE = path.join(config.get('dataDir'), 'jobs.json');
const DLQ_FILE = path.join(config.get('dataDir'), 'dlq.json');
const LOCK_FILE = path.join(config.get('dataDir'), '.lock');

class Storage {
  constructor() {
    this.jobs = new Map();
    this.dlq = new Map();
    this.lockHandle = null;
    this.load();
  }

  // Simple file-based locking
  acquireLock() {
    if (this.lockHandle) return true;
    
    try {
      if (fs.existsSync(LOCK_FILE)) {
        const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'));
        // Check if process is still running (simple check)
        try {
          process.kill(pid, 0);
          return false; // Lock held by running process
        } catch {
          // Process doesn't exist, remove stale lock
          fs.unlinkSync(LOCK_FILE);
        }
      }
      
      fs.writeFileSync(LOCK_FILE, process.pid.toString());
      this.lockHandle = true;
      return true;
    } catch (error) {
      return false;
    }
  }

  releaseLock() {
    if (this.lockHandle && fs.existsSync(LOCK_FILE)) {
      try {
        fs.unlinkSync(LOCK_FILE);
        this.lockHandle = null;
      } catch (error) {
        // Ignore
      }
    }
  }

  load() {
    try {
      if (fs.existsSync(JOBS_FILE)) {
        const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
        this.jobs = new Map(Object.entries(data));
      }

      if (fs.existsSync(DLQ_FILE)) {
        const data = JSON.parse(fs.readFileSync(DLQ_FILE, 'utf8'));
        this.dlq = new Map(Object.entries(data));
      }
    } catch (error) {
      console.error('Error loading storage:', error.message);
      this.jobs = new Map();
      this.dlq = new Map();
    }
  }

  save() {
    try {
      const jobsObj = Object.fromEntries(this.jobs);
      fs.writeFileSync(JOBS_FILE, JSON.stringify(jobsObj, null, 2));
      
      const dlqObj = Object.fromEntries(this.dlq);
      fs.writeFileSync(DLQ_FILE, JSON.stringify(dlqObj, null, 2));
    } catch (error) {
      console.error('Error saving storage:', error.message);
      throw error;
    }
  }

  // Job operations
  addJob(job) {
    // If job is a Job instance, convert to plain object
    const jobData = job.toJSON ? job.toJSON() : job;
    this.jobs.set(jobData.id, jobData);
    this.save();
  }

  getJob(id) {
    return this.jobs.get(id);
  }

  updateJob(job) {
    // Ensure we have the latest data
    this.load();
    if (this.jobs.has(job.id)) {
      // If job is a Job instance, convert to plain object
      const jobData = job.toJSON ? job.toJSON() : job;
      this.jobs.set(jobData.id, jobData);
      this.save();
      return true;
    }
    return false;
  }

  deleteJob(id) {
    if (this.jobs.has(id)) {
      this.jobs.delete(id);
      this.save();
      return true;
    }
    return false;
  }

  getJobsByState(state) {
    return Array.from(this.jobs.values()).filter(job => job.state === state);
  }

  getAllJobs() {
    return Array.from(this.jobs.values());
  }

  // Get next pending job (with locking to prevent duplicate processing)
  getNextPendingJob() {
    // Retry mechanism for acquiring lock
    const maxRetries = 10;
    const retryDelay = 100; // ms
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Reload to get latest state
      this.load();
      
      const pendingJobs = this.getJobsByState('pending')
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      
      for (const job of pendingJobs) {
        // Try to acquire lock
        if (this.acquireLockWithRetry(3, 50)) {
          try {
            // Double-check job state after acquiring lock
            this.load();
            const currentJob = this.getJob(job.id);
            
            if (currentJob && currentJob.state === 'pending') {
              // Mark as processing atomically
              currentJob.state = 'processing';
              currentJob.updated_at = new Date().toISOString();
              this.jobs.set(currentJob.id, currentJob);
              this.save();
              this.releaseLock();
              return currentJob;
            }
          } catch (error) {
            this.releaseLock();
            // Continue to next job
          }
        }
      }
      
      // If no job found, wait a bit before retrying
      if (pendingJobs.length === 0) {
        break;
      }
      
      // Small delay before retry
      if (attempt < maxRetries - 1) {
        this.sleep(retryDelay);
      }
    }
    
    return null;
  }

  acquireLockWithRetry(maxRetries = 5, delay = 100) {
    for (let i = 0; i < maxRetries; i++) {
      if (this.acquireLock()) {
        return true;
      }
      this.sleep(delay);
    }
    return false;
  }

  sleep(ms) {
    // Use Atomics for better performance, fallback to setTimeout
    if (typeof Atomics !== 'undefined' && Atomics.wait) {
      const sharedArray = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sharedArray, 0, 0, ms);
    } else {
      // Simple blocking sleep for file operations
      const start = Date.now();
      while (Date.now() - start < ms) {
        // Busy wait (acceptable for short durations in file locking)
      }
    }
  }

  // DLQ operations
  moveToDLQ(job) {
    // If job is a Job instance, convert to plain object
    const jobData = job.toJSON ? job.toJSON() : job;
    jobData.state = 'dead';
    jobData.updated_at = new Date().toISOString();
    this.dlq.set(jobData.id, jobData);
    this.jobs.delete(jobData.id);
    this.save();
  }

  getDLQJobs() {
    return Array.from(this.dlq.values());
  }

  retryFromDLQ(jobId) {
    const job = this.dlq.get(jobId);
    if (!job) return null;

    // Reset job state
    job.state = 'pending';
    job.attempts = 0;
    job.updated_at = new Date().toISOString();
    
    this.dlq.delete(jobId);
    this.jobs.set(job.id, job);
    this.save();
    
    return job;
  }

  // Get statistics
  getStats() {
    const jobs = this.getAllJobs();
    const stats = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      dead: this.dlq.size
    };

    jobs.forEach(job => {
      if (stats[job.state] !== undefined) {
        stats[job.state]++;
      }
    });

    return stats;
  }
}

// Singleton instance
module.exports = new Storage();

