class Job {
  constructor(data) {
    this.id = data.id || this.generateId();
    this.command = data.command;
    this.state = data.state || 'pending';
    this.attempts = data.attempts || 0;
    this.max_retries = data.max_retries || 3;
    this.created_at = data.created_at || new Date().toISOString();
    this.updated_at = data.updated_at || new Date().toISOString();
    this.error = data.error || null;
    this.next_retry_at = data.next_retry_at || null;
  }

  generateId() {
    // Generate a unique ID compatible with all Node.js versions
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 11);
    return `job-${timestamp}-${random}`;
  }

  toJSON() {
    return {
      id: this.id,
      command: this.command,
      state: this.state,
      attempts: this.attempts,
      max_retries: this.max_retries,
      created_at: this.created_at,
      updated_at: this.updated_at,
      error: this.error,
      next_retry_at: this.next_retry_at
    };
  }

  static fromJSON(data) {
    return new Job(data);
  }

  canRetry() {
    return this.attempts < this.max_retries && this.state === 'failed';
  }

  shouldRetryNow() {
    if (!this.next_retry_at) return true;
    return new Date() >= new Date(this.next_retry_at);
  }

  calculateNextRetry(base) {
    const delay = Math.pow(base, this.attempts);
    const nextRetry = new Date();
    nextRetry.setSeconds(nextRetry.getSeconds() + delay);
    return nextRetry.toISOString();
  }
}

module.exports = Job;

