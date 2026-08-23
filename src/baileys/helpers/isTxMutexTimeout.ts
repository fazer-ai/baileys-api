// The sentinel the patched `addTransactionCapability` puts on the Boom it
// throws when a keystore transaction gives up waiting for its mutex. Kept as a
// string constant rather than an imported class because the throw site lives
// inside node_modules: there is no shared type to instanceof against, and the
// spec that guards the patch (authTransactionTimeout.spec.ts) asserts on this
// same literal appearing in the installed file.
export const TX_MUTEX_TIMEOUT_CODE = "E_TX_MUTEX_TIMEOUT";

// Distinguishes "the operation left the mutex queue" from "the operation left
// because the mutex is wedged". Both are rejections and both mean nothing is
// parked any more, but only the first is evidence the connection recovered:
// this one reports the wedge that the send-stall watchdog exists to contain.
export function isTxMutexTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) {
    return false;
  }
  return (
    (error as { data: { code?: unknown } }).data.code === TX_MUTEX_TIMEOUT_CODE
  );
}

// The keystore key the timed-out acquisition was waiting on, straight from the
// Boom the patch throws. Read from OUR OWN send's failure, this is the only
// unambiguous statement of which mutex is blocking sends: a `stalled` event
// names whatever key happened to be held long, which is often an unrelated one.
export function txMutexTimeoutKey(error: unknown): string | null {
  if (!isTxMutexTimeout(error)) {
    return null;
  }
  const key = (error as { data: { key?: unknown } }).data.key;
  return typeof key === "string" ? key : null;
}
