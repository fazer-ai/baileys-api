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

export function registerAudioJob(id: number, job: KillableJob): void {
  running.set(id, job);
}

export function completeAudioJob(id: number): void {
  running.delete(id);
}

// SIGKILL rather than SIGTERM: the case this exists for is a conversion that
// stopped making progress, and a process in that state is the one least likely
// to act on a polite signal. Killing makes the command emit `error`, so the
// worker's own finally still removes the temp file.
export function cancelAudioJob(id: number): boolean {
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
