import {
  type AuthenticationCreds,
  initAuthCreds,
} from "@whiskeysockets/baileys";

// Shape produced by the browser extension's WhatsApp Web session extractor
// (a fork of whatsapp-session-extractor). Every binary field is a base64
// string. `advSecretKey` is base64 too but stays a string in creds — never a
// Buffer — matching what initAuthCreds() produces.
//
// The Noise keypair cannot be resolved to a single value on the extractor
// side: the HKDF + IV combinations yield several candidates and only one is
// the real private->public pair. The client picks the right one by connecting;
// see the candidate-cycling logic in the connection handler.
export interface ExtractedSession {
  noiseCandidates: { private: string; public: string }[];
  identityKey: { private: string; public: string };
  registrationId: number;
  advSecretKey: string;
  account: {
    details: string;
    accountSignatureKey: string;
    accountSignature: string;
    deviceSignature: string;
  };
  id: string;
  lid?: string | null;
  platform?: string | null;
  signedPreKey?: {
    keyId: number;
    private: string;
    public: string;
    signature: string;
  } | null;
  pushName?: string | null;
  routingInfo?: string | null;
}

export class InvalidNoiseCandidateError extends Error {}

const toBuffer = (value: string) => Buffer.from(value, "base64");

const toKeyPair = (kp: { private: string; public: string }) => ({
  private: toBuffer(kp.private),
  public: toBuffer(kp.public),
});

// The Signal wire format prefixes a raw curve25519 public key with the 0x05
// type byte. `account.accountSignatureKey` is the raw key; the companion's own
// signalIdentity records it prefixed.
const toSignalIdentityKey = (accountSignatureKeyB64: string) =>
  Buffer.concat([Buffer.from([5]), toBuffer(accountSignatureKeyB64)]);

// Maps an extracted WhatsApp Web session to Baileys AuthenticationCreds.
//
// Starts from initAuthCreds() so runtime-only fields (pre-key counters,
// accountSettings, a well-typed pairingEphemeralKeyPair, ...) get valid
// defaults, then overlays the transplanted identity. Because `me.id` is set
// and `registered` is true, the socket resumes as an already-linked companion
// and never emits a QR.
//
// The field mapping mirrors the whatsapp-session-extractor reference, which is
// the empirically-validated shape (notably: advSecretKey <- WANoiseInfo
// recoveryToken, account <- adv_signed_identity, signedPreKey is a nested
// SignedKeyPair). Validate end-to-end on a test number before relying on it.
export function mapSessionToCreds(
  session: ExtractedSession,
  candidateIndex = 0,
): AuthenticationCreds {
  const candidate = session.noiseCandidates[candidateIndex];
  if (!candidate) {
    throw new InvalidNoiseCandidateError(
      `noise candidate index ${candidateIndex} out of range (have ${session.noiseCandidates.length})`,
    );
  }

  const base = initAuthCreds();

  // The extractor hands the LID over as a `@s.whatsapp.net` JID, but Baileys
  // addresses linked identities on the `@lid` domain. Normalize once and use
  // the same value for both signalIdentities and me.lid so downstream identity
  // and LID lookups stay consistent (they must resolve to the same JID).
  const normalizedLid = session.lid
    ? session.lid.replace("@s.whatsapp.net", "@lid")
    : undefined;

  const signalIdentities: AuthenticationCreds["signalIdentities"] =
    normalizedLid
      ? [
          {
            identifier: {
              name: normalizedLid,
              deviceId: 0,
            },
            identifierKey: toSignalIdentityKey(
              session.account.accountSignatureKey,
            ),
          },
        ]
      : [];

  return {
    ...base,
    noiseKey: toKeyPair(candidate),
    signedIdentityKey: toKeyPair(session.identityKey),
    signedPreKey: session.signedPreKey
      ? {
          keyId: session.signedPreKey.keyId,
          keyPair: toKeyPair(session.signedPreKey),
          signature: toBuffer(session.signedPreKey.signature),
        }
      : base.signedPreKey,
    registrationId: session.registrationId,
    advSecretKey: session.advSecretKey,
    account: {
      details: toBuffer(session.account.details),
      accountSignatureKey: toBuffer(session.account.accountSignatureKey),
      accountSignature: toBuffer(session.account.accountSignature),
      deviceSignature: toBuffer(session.account.deviceSignature),
    },
    me: {
      id: session.id,
      name: session.pushName ?? undefined,
      lid: normalizedLid,
    },
    signalIdentities,
    platform: session.platform ?? undefined,
    routingInfo: session.routingInfo
      ? toBuffer(session.routingInfo)
      : undefined,
    registered: true,
  };
}
