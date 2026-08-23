// The audio worker starts an independent ffmpeg child process per message it
// receives -- its onmessage is async and does not serialise -- so a conversion
// the caller has abandoned keeps a process, a temp file and its memory alive
// until it finishes on its own, which for a wedged job is never. The worker pool
// being fixed-size bounds the number of WORKERS, not the number of children.
//
// This is the bookkeeping that lets the worker kill an abandoned job. It lives
// outside the worker file so it can be tested: importing that file requires a
// Worker global and would register a message handler.
export interface KillableJob {
  kill(signal: string): void;
}

const running = new Map<number, KillableJob>();
// Cancellations that arrived before there was anything to kill. fluent-ffmpeg
// spawns asynchronously: during _prepare and its capability probing there is no
// ffmpegProc yet, and kill() is a no-op that only logs. Forgetting the
// cancellation there lets the process start afterwards and run unbounded, which
// is the exact outcome the deadline exists to prevent.
const cancelled = new Set<number>();
// The tombstone only has to outlive fluent-ffmpeg's preparation, which is
// milliseconds. It is expired rather than left in place because a cancel can
// also lose the race to a job that already completed -- the worker finished and
// posted, the caller's deadline fired before that message was handled -- and
// nothing would ever clear THAT id. One narrow race per audio send is enough to
// grow this set without bound over the life of a worker.
const CANCEL_TOMBSTONE_MS = 60_000;

export function registerAudioJob(id: number, job: KillableJob): void {
  running.set(id, job);
  // The cancel may already have been decided while this job was still preparing.
  if (cancelled.has(id)) {
    cancelAudioJob(id);
  }
}

export function isAudioJobCancelled(id: number): boolean {
  return cancelled.has(id);
}

export function completeAudioJob(id: number): void {
  running.delete(id);
  cancelled.delete(id);
}

// SIGKILL rather than SIGTERM: the case this exists for is a conversion that
// stopped making progress, and a process in that state is the one least likely
// to act on a polite signal. Killing makes the command emit `error`, so the
// worker's own finally still removes the temp file.
export function cancelAudioJob(id: number): boolean {
  cancelled.add(id);
  const expiry = setTimeout(() => cancelled.delete(id), CANCEL_TOMBSTONE_MS);
  expiry.unref?.();
  const job = running.get(id);
  if (!job) {
    return false;
  }
  running.delete(id);
  job.kill("SIGKILL");
  return true;
}

export function runningAudioJobCount(): number {
  return running.size;
}
