const prefix = "@baileys-api:cluster";

export const clusterKeys = {
  lease: (phoneNumber: string) => `${prefix}:lease:${phoneNumber}`,
  // Monotonic per-phone counter, bumped on every successful acquire. Owner
  // epochs strictly increase across successive owners, so a stale owner can
  // always be detected by comparing epochs.
  leaseEpoch: (phoneNumber: string) => `${prefix}:lease-epoch:${phoneNumber}`,
  instance: (instanceId: string) => `${prefix}:instance:${instanceId}`,
  instancePattern: `${prefix}:instance:*`,
  handoff: (phoneNumber: string) => `${prefix}:handoff:${phoneNumber}`,
  cooldown: (phoneNumber: string) => `${prefix}:cooldown:${phoneNumber}`,
  eventsChannel: `${prefix}:events`,
};

export const mediaOwnerKey = (messageId: string) =>
  `@baileys-api:media-owner:${messageId}`;
