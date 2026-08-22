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
