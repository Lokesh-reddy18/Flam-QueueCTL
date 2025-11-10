# QueueCTL

A CLI-based background job queue system built with Node.js. QueueCTL manages background jobs with worker processes, handles retries using exponential backoff, and maintains a Dead Letter Queue (DLQ) for permanently failed jobs.

## Features

- ✅ **Job Management**: Enqueue, monitor, and manage background jobs
- ✅ **Worker Processes**: Run multiple workers in parallel for concurrent job processing
- ✅ **Automatic Retries**: Failed jobs automatically retry with exponential backoff
- ✅ **Dead Letter Queue**: Permanently failed jobs are moved to DLQ for manual inspection
- ✅ **Persistent Storage**: Jobs persist across restarts using JSON file storage
- ✅ **Configuration Management**: Configurable retry counts and backoff settings
- ✅ **Shutdown**: Workers finish current jobs before stopping
- ✅ **Job Locking**: Prevents duplicate processing with file-based locking

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd queuectl
```

2. Install dependencies:
```bash
npm install
```

3. Make the CLI executable (Unix/Linux/Mac):
```bash
chmod +x src/cli.js
```

4. (Optional) Install globally:
```bash
npm link
```

## Usage

### Basic Commands

#### Enqueue a Job

Add a new job to the queue:

**Linux/Mac:**
```bash
node src/cli.js enqueue '{"id":"job1","command":"echo Hello World"}'
```

**Windows (PowerShell):**
```powershell
node src/cli.js enqueue '{\"id\":\"job1\",\"command\":\"echo Hello World\"}'
```

Or with auto-generated ID:

**Linux/Mac:**
```bash
node src/cli.js enqueue '{"command":"sleep 2"}'
```

**Windows (PowerShell):**
```powershell
node src/cli.js enqueue '{\"command\":\"sleep 2\"}'
```

**Windows (Alternative - using file):**
```powershell
# Create a file job.json with: {"id":"job1","command":"echo Hello World"}
node src/cli.js enqueue job.json
```

**Note:** On Windows PowerShell, quote escaping can be tricky. The easiest approach is to save the JSON to a file and pass the filename, or use the file-based approach shown above.

#### Start Workers

Start worker processes to process jobs:

```bash
# Start a single worker
node src/cli.js worker start

# Start multiple workers
node src/cli.js worker start --count 3
```

#### Stop Workers

Stop running workers gracefully:

```bash
node src/cli.js worker stop
```

#### Check Status

View summary of job states and worker status:

```bash
node src/cli.js status
```

Output example:
```
=== Queue Status ===

Pending:    2
Processing: 1
Completed:  5
Failed:     0
Dead (DLQ): 1

Workers:    Running
```

#### List Jobs

List jobs filtered by state:

```bash
# List all jobs
node src/cli.js list

# List pending jobs
node src/cli.js list --state pending

# List completed jobs
node src/cli.js list --state completed

# List failed jobs
node src/cli.js list --state failed

# List dead letter queue jobs
node src/cli.js list --state dead
```

#### Dead Letter Queue

View DLQ jobs:

```bash
node src/cli.js dlq list
```

Retry a job from DLQ:

```bash
node src/cli.js dlq retry job1
```

#### Configuration

Set configuration values:

```bash
# Set max retries
node src/cli.js config set max-retries 5

# Set backoff base
node src/cli.js config set backoff-base 3
```

Get configuration value:

```bash
node src/cli.js config get max-retries
```

List all configuration:

```bash
node src/cli.js config list
```

## Job Specification

Each job contains the following fields:

```json
{
  "id": "unique-job-id",
  "command": "echo 'Hello World'",
  "state": "pending",
  "attempts": 0,
  "max_retries": 3,
  "created_at": "2025-11-04T10:30:00Z",
  "updated_at": "2025-11-04T10:30:00Z",
  "error": null,
  "next_retry_at": null
}
```

### Job States

| State | Description |
|-------|-------------|
| `pending` | Waiting to be picked up by a worker |
| `processing` | Currently being executed |
| `completed` | Successfully executed |
| `failed` | Failed, but retryable |
| `dead` | Permanently failed (moved to DLQ) |

## Architecture Overview

### Job Lifecycle

1. **Enqueue**: Job is added to the queue with state `pending`
2. **Processing**: Worker picks up the job and changes state to `processing`
3. **Completion**: On success, job state changes to `completed`
4. **Retry**: On failure, job retries with exponential backoff (state: `failed`)
5. **DLQ**: After max retries, job moves to Dead Letter Queue (state: `dead`)

### Exponential Backoff

Failed jobs retry with exponential backoff:

```
delay = base ^ attempts seconds
```

For example, with `backoff-base = 2`:
- Attempt 1: 2^0 = 1 second
- Attempt 2: 2^1 = 2 seconds
- Attempt 3: 2^2 = 4 seconds

### Data Persistence

Jobs are stored in JSON files:
- `~/.queuectl/data/jobs.json` - Active jobs
- `~/.queuectl/data/dlq.json` - Dead Letter Queue
- `~/.queuectl/config.json` - Configuration

### Worker Management

- Multiple workers can run concurrently
- File-based locking prevents duplicate job processing
- Workers poll for jobs every second
- Graceful shutdown: workers finish current jobs before exiting

### Concurrency Control

- File-based locking mechanism prevents race conditions
- Jobs are atomically marked as `processing` when picked up
- Storage is reloaded before critical operations to ensure consistency

## Testing

Run the test script to verify core functionality:

```bash
npm test
```

Or manually:

```bash
node test/test.js
```

The test script validates:
1. Basic job completion
2. Failed job retries with backoff
3. Multiple workers processing jobs
4. Invalid commands fail gracefully
5. Job data persists across restarts
6. DLQ functionality

## Example Workflow

1. **Start workers**:
```bash
node src/cli.js worker start --count 2
```

2. **Enqueue some jobs**:
```bash
node src/cli.js enqueue '{"command":"echo Success"}'
node src/cli.js enqueue '{"command":"sleep 1"}'
node src/cli.js enqueue '{"command":"nonexistent-command"}'
```

3. **Check status**:
```bash
node src/cli.js status
```

4. **List jobs**:
```bash
node src/cli.js list --state completed
node src/cli.js list --state dead
```

5. **Retry from DLQ**:
```bash
node src/cli.js dlq list
node src/cli.js dlq retry <job-id>
```

6. **Stop workers**:
```bash
node src/cli.js worker stop
```

## Configuration

Default configuration:
- `max-retries`: 3
- `backoff-base`: 2
- `data-dir`: `~/.queuectl/data`

Configuration is stored in `~/.queuectl/config.json` and can be modified via CLI commands.

## Assumptions & Trade-offs

### Assumptions

1. **File-based Storage**: Using JSON files for simplicity. For production, consider SQLite or a proper database.
2. **File Locking**: Simple file-based locking works for moderate concurrency. For high concurrency, consider a proper locking mechanism (e.g., Redis, database locks).
3. **Command Execution**: Commands are executed in system shell. Ensure proper security for untrusted commands.
4. **Single Machine**: Designed for single-machine deployment. For distributed systems, consider a message queue (Redis, RabbitMQ, etc.).

### Trade-offs

1. **Persistence**: JSON file storage is simple but may have performance limitations with many jobs.
2. **Locking**: File-based locking is simple but not as robust as database-level locking.
3. **Worker Process**: Workers run in the same process. For true process isolation, consider spawning separate processes.
4. **Polling**: Workers poll for jobs every second. For lower latency, consider event-driven approaches.

## Project Structure

```
queuectl/
├── src/
│   ├── cli.js          # CLI interface
│   ├── config.js       # Configuration management
│   ├── job.js          # Job model
│   ├── storage.js      # Job storage and persistence
│   └── worker.js       # Worker processes
├── test/
│   └── test.js         # Test script
├── package.json        # Dependencies
└── README.md          # Documentation
```

## Troubleshooting

### Workers not starting

- Check if workers are already running: `node src/cli.js status`
- Remove stale PID file: `rm ~/.queuectl/workers.pid`

### Jobs not processing

- Verify workers are running: `node src/cli.js status`
- Check job states: `node src/cli.js list`
- Verify job commands are valid

### Lock file issues

- Remove stale lock file: `rm ~/.queuectl/data/.lock`
- Ensure proper file permissions

## Demo Video

Watch the working CLI demo here:

- Direct link: https://drive.google.com/file/d/1bFiQ3G16X7cr0YhplgKAWAuZUcCjW9aQ/view?usp=sharing

[![Watch the demo](https://img.shields.io/badge/Watch%20Demo-Google%20Drive-blue)](https://drive.google.com/file/d/1bFiQ3G16X7cr0YhplgKAWAuZUcCjW9aQ/view?usp=sharing)

