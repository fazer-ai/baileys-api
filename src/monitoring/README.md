# Memory Leak Monitoring System

This monitoring system provides comprehensive memory leak detection for the Baileys API without modifying core business logic.

## Components

### 1. Memory Monitor (`memoryMonitor.ts`)
- Tracks memory usage over time
- Detects significant memory increases (>50% from baseline)
- Identifies continuous memory growth patterns
- Provides trend analysis (increasing, decreasing, stable)

### 2. Connection Tracker (`connectionTracker.ts`)
- Monitors WhatsApp connection lifecycle
- Tracks connection creation, activity, and cleanup
- Identifies stale connections (inactive >5 minutes)
- Reports connection statistics

### 3. File System Monitor (`fileSystemMonitor.ts`)
- Monitors the `media` directory for size and old files
- Warns when directory exceeds 1GB
- Identifies files older than 24 hours
- Helps detect media file cleanup issues

### 4. Resource Middleware (`resourceMiddleware.ts`)
- Tracks HTTP request memory impact
- Logs memory-intensive requests (>50MB increase)
- Monitors request-specific memory growth
- Provides resource usage metrics

## API Endpoints

### `GET /monitoring/memory`
Returns detailed memory usage report including:
- Current memory usage
- Memory trend analysis
- Connection statistics
- Resource metrics

### `GET /monitoring/health`
Returns simplified health status with:
- Memory status and trend
- Connection counts (active/stale)
- Request statistics
- Overall system status

## Automatic Monitoring

The system automatically starts when the application launches and runs:

- **Memory checks**: Every 30 seconds
- **File system checks**: Every minute
- **Connection reports**: Every 2 minutes
- **Memory trend reports**: Every 5 minutes

## Key Features

- **Non-intrusive**: No changes to existing business logic
- **Real-time**: Continuous monitoring with configurable intervals
- **Actionable**: Clear warnings for potential memory leak scenarios
- **Comprehensive**: Covers memory, connections, files, and requests
- **Safe**: Can be easily disabled or removed without affecting core functionality

## Warning Triggers

The system will log warnings for:

1. **Memory Growth**: 
   - Heap increase >50% from baseline
   - Continuous growth over 5 measurements

2. **Connection Issues**:
   - Stale connections (inactive >5 minutes)
   - Excessive connection count

3. **File System Issues**:
   - Media directory >1GB
   - >100 files older than 24 hours

4. **Request Issues**:
   - Requests causing >10MB memory increase
   - High baseline memory usage

## Usage

The monitoring system starts automatically and logs to the application logger. Monitor the logs for warnings and use the API endpoints to get detailed reports.

Example log output:
```
[INFO] Memory monitoring started. Baseline: {...}
[INFO] Memory trend: stable, Current heap: 45 MB
[WARN] Continuous memory growth detected: 15 MB over last 5 measurements
[INFO] Connection Report: 3 active, 0 stale
```
