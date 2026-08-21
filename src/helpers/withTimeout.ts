export class OperationTimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = "OperationTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

// Bounds how long we wait on `fn`, NOT how long `fn` runs: there is no
// cancellation token to hand Baileys, so a timed-out send stays parked inside
// the socket's keystore mutex and settles (or never does) on its own. Callers
// must treat a timeout as "outcome unknown", never as "did not happen".
//
// Two details that are easy to get wrong and both bite in production:
// the losing promise is silenced, so its eventual rejection does not surface as
// an unhandled rejection long after we already answered the caller; and the
// timer is always cleared, so a 45s handle does not sit on the event loop for
// every single send.
export function withTimeout<T>(
  operation: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const underlying = fn();
  underlying.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new OperationTimeoutError(operation, timeoutMs)),
      timeoutMs,
    );
    timer.unref?.();
  });

  return Promise.race([underlying, deadline]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}
