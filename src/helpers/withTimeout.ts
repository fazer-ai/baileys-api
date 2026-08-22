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
//
// `onLateSettle` is how a caller learns the abandoned operation eventually
// finished. Without it a circuit breaker built on these timeouts can only ever
// open: the outcome that would close it is precisely the one this function has
// already stopped reporting.
//
// It fires on rejection too, with the error, and that half is not decoration:
// an operation that fails slowly (a stalled media upload, say) leaves the queue
// exactly like one that succeeds slowly. Reporting only successes latches a
// breaker on a connection where nothing is parked at all. The error is passed
// through rather than swallowed so the caller can tell an ordinary failure from
// one that reports the resource is still wedged.
export function withTimeout<T>(
  operation: string,
  timeoutMs: number,
  fn: () => Promise<T>,
  onLateSettle?: (error?: unknown, value?: T) => void,
): Promise<T> {
  let timedOut = false;
  const underlying = fn();
  underlying.then(
    (value) => {
      if (timedOut) {
        // The value comes with it: the caller's success path never ran, so
        // anything it would have recorded from the result is only available
        // here. For a send that is the message id WhatsApp actually used.
        onLateSettle?.(undefined, value);
      }
    },
    (error: unknown) => {
      if (timedOut) {
        onLateSettle?.(error ?? new Error(`${operation} failed`));
      }
    },
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new OperationTimeoutError(operation, timeoutMs));
    }, timeoutMs);
    timer.unref?.();
  });

  return Promise.race([underlying, deadline]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}
