import { clusterKeys } from "@/cluster/keys";
import config from "@/config";
import redis from "@/lib/redis";

// Breaks the claim/abort/re-claim livelock: without it, a phone whose session
// the server rejects on every handshake (observed in production as
// stream:error 503 for weeks straight) is re-claimed by the coordinator every
// claim tick, burning thousands of reconnect cycles a day and hammering
// WhatsApp from the same IP. A strike is one FULL failed reconnect cycle (10
// attempts ending in abort), not one dropped socket.
//
// Lifecycle: recordStrike on every aborted cycle (backoff doubles per
// strike), isQuarantined consulted by background claims only, cleared by a
// healthy open or by explicit user intent (POST /connections, import-session)
// — a human asking for the phone always wins immediately.
export interface QuarantineState {
  strikes: number;
  nextRetryAt: number;
}

// Key lifetime, not the backoff cap: keeps the strike history inspectable for
// a while after the phone recovers or is abandoned, then self-cleans.
const QUARANTINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Exponent clamp so a long-running strike streak cannot overflow the double
// (2 ** 1024 === Infinity); past this the cap has long taken over anyway.
const MAX_BACKOFF_EXPONENT = 25;

export function backoffMs(strikes: number): number {
  const { quarantineBaseMs, quarantineMaxMs } = config.cluster;
  const exponent = Math.min(Math.max(strikes - 1, 0), MAX_BACKOFF_EXPONENT);
  return Math.min(quarantineBaseMs * 2 ** exponent, quarantineMaxMs);
}

// Plain read-modify-write, no CAS: the only writer is the instance whose
// socket just aborted, and two instances can only race here across an
// ownership change mid-cycle — worst case one strike is lost, which merely
// shortens the backoff by one doubling.
export async function recordStrike(
  phoneNumber: string,
): Promise<QuarantineState | null> {
  if (!config.cluster.quarantineEnabled) {
    return null;
  }
  const key = clusterKeys.quarantine(phoneNumber);
  const raw = await redis.get(key);
  let strikes = 1;
  if (raw) {
    try {
      strikes = (JSON.parse(raw) as QuarantineState).strikes + 1;
    } catch {
      // Corrupted entry: restart the strike count rather than fail the abort
      // path that records it.
    }
  }
  const state: QuarantineState = {
    strikes,
    nextRetryAt: Date.now() + backoffMs(strikes),
  };
  await redis.set(key, JSON.stringify(state), {
    expiration: { type: "PX", value: QUARANTINE_TTL_MS },
  });
  return state;
}

export async function isQuarantined(phoneNumber: string): Promise<boolean> {
  if (!config.cluster.quarantineEnabled) {
    return false;
  }
  const raw = await redis.get(clusterKeys.quarantine(phoneNumber));
  if (!raw) {
    return false;
  }
  try {
    return (JSON.parse(raw) as QuarantineState).nextRetryAt > Date.now();
  } catch {
    return false;
  }
}

export async function clearQuarantine(phoneNumber: string): Promise<void> {
  await redis.del(clusterKeys.quarantine(phoneNumber));
}
