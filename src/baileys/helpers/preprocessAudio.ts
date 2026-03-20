import logger from "@/lib/logger";

type AudioFormat = "ogg-low" | "mp3-high" | "wav";

interface PendingRequest {
  resolve: (result: Buffer) => void;
  reject: (error: Error) => void;
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

export async function preprocessAudio(
  audio: Buffer,
  format: AudioFormat,
): Promise<Buffer> {
  const pool = getWorkerPool();
  const worker = pool[nextWorkerIndex % pool.length];
  nextWorkerIndex++;

  const id = messageId++;
  const arrayBuffer = new Uint8Array(audio).buffer as ArrayBuffer;

  return new Promise<Buffer>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    worker.postMessage({ id, audio: arrayBuffer, format }, [arrayBuffer]);
  });
}
