import logger from "@/lib/logger";

type AudioFormat = "ogg-low" | "mp3-high" | "wav";

interface PendingRequest {
  resolve: (result: Buffer) => void;
  reject: (error: Error) => void;
}

export class AudioPreprocessAbortedError extends Error {
  constructor() {
    super("audio preprocessing aborted");
    this.name = "AudioPreprocessAbortedError";
  }
}

const POOL_SIZE =
  typeof navigator !== "undefined" && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 4;

const workers: Worker[] = [];
let nextWorkerIndex = 0;
let messageId = 0;
const pendingRequests = new Map<number, PendingRequest>();

function getWorkerPool(): Worker[] {
  if (workers.length > 0) {
    return workers;
  }

  for (let i = 0; i < POOL_SIZE; i++) {
    const worker = new Worker(
      new URL("./preprocessAudioWorker.ts", import.meta.url).href,
    );

    worker.onmessage = (
      event: MessageEvent<{
        id: number;
        result?: ArrayBuffer;
        error?: string;
      }>,
    ) => {
      const { id, result, error } = event.data;
      const pending = pendingRequests.get(id);
      if (!pending) {
        return;
      }
      pendingRequests.delete(id);

      if (error) {
        pending.reject(new Error(error));
      } else if (result) {
        pending.resolve(Buffer.from(result));
      }
    };

    worker.onerror = (event) => {
      logger.error("Audio worker error: %s", event.message);
      for (const [id, pending] of pendingRequests) {
        pending.reject(new Error(`Worker error: ${event.message}`));
        pendingRequests.delete(id);
      }
    };

    workers.push(worker);
  }

  return workers;
}

// `signal` is how a caller that has stopped waiting says so. Without it a
// abandoned conversion leaves its entry in pendingRequests and its promise
// pending for as long as the worker takes -- forever if the job is wedged, which
// is exactly the case a deadline exists for.
//
// It does not TERMINATE the worker, and does not need to: the pool is
// round-robin, so several conversions share one worker and killing it to reclaim
// a slot would take healthy jobs down with it. What the abort does instead is
// tell that worker to kill the one job, which is the thing actually holding
// resources -- the worker itself is idle between messages.
export async function preprocessAudio(
  audio: Buffer,
  format: AudioFormat,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (signal?.aborted) {
    throw new AudioPreprocessAbortedError();
  }

  const pool = getWorkerPool();
  const worker = pool[nextWorkerIndex % pool.length];
  nextWorkerIndex++;

  const id = messageId++;
  const arrayBuffer = new Uint8Array(audio).buffer as ArrayBuffer;

  return new Promise<Buffer>((resolve, reject) => {
    const onAbort = () => {
      // Only if it is still ours: a reply that arrived first already removed it.
      if (!pendingRequests.delete(id)) {
        return;
      }
      // Dropping our callback is not enough. The worker's onmessage is async, so
      // it started an ffmpeg CHILD PROCESS for this job and is already free to
      // start another for the next one; abandoning it leaves that process, its
      // temp file and its memory alive until it finishes on its own, which for
      // the wedged job this deadline exists for is never.
      worker.postMessage({ id, cancel: true });
      reject(new AudioPreprocessAbortedError());
    };
    const settle = <T>(finish: (value: T) => void) => {
      return (value: T) => {
        signal?.removeEventListener("abort", onAbort);
        finish(value);
      };
    };
    pendingRequests.set(id, {
      resolve: settle(resolve),
      reject: settle(reject),
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.postMessage({ id, audio: arrayBuffer, format }, [arrayBuffer]);
  });
}
