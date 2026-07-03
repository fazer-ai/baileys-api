import { describe, expect, it } from "bun:test";
import {
  type ExtractedSession,
  InvalidNoiseCandidateError,
  mapSessionToCreds,
} from "./importSession";

const b64 = (s: string) => Buffer.from(s).toString("base64");

const baseSession = (): ExtractedSession => ({
  noiseCandidates: [
    { private: b64("noise-priv-0"), public: b64("noise-pub-0") },
    { private: b64("noise-priv-1"), public: b64("noise-pub-1") },
  ],
  identityKey: { private: b64("id-priv"), public: b64("id-pub") },
  registrationId: 42,
  advSecretKey: b64("adv-secret"),
  account: {
    details: b64("acc-details"),
    accountSignatureKey: b64("acc-sig-key"),
    accountSignature: b64("acc-sig"),
    deviceSignature: b64("dev-sig"),
  },
  id: "551101234567:12@s.whatsapp.net",
  lid: "551101234567@s.whatsapp.net",
  platform: "android",
  signedPreKey: {
    keyId: 7,
    private: b64("spk-priv"),
    public: b64("spk-pub"),
    signature: b64("spk-sig"),
  },
  pushName: "Alice",
});

describe("mapSessionToCreds", () => {
  it("maps base64 keypairs to Buffers", () => {
    const creds = mapSessionToCreds(baseSession());
    expect(creds.noiseKey.private).toEqual(Buffer.from("noise-priv-0"));
    expect(creds.noiseKey.public).toEqual(Buffer.from("noise-pub-0"));
    expect(creds.signedIdentityKey.private).toEqual(Buffer.from("id-priv"));
    expect(creds.signedIdentityKey.public).toEqual(Buffer.from("id-pub"));
  });

  it("selects the requested noise candidate", () => {
    const creds = mapSessionToCreds(baseSession(), 1);
    expect(creds.noiseKey.private).toEqual(Buffer.from("noise-priv-1"));
  });

  it("throws when the candidate index is out of range", () => {
    expect(() => mapSessionToCreds(baseSession(), 5)).toThrow(
      InvalidNoiseCandidateError,
    );
  });

  it("marks the session as registered and sets me with a normalized @lid", () => {
    const creds = mapSessionToCreds(baseSession());
    expect(creds.registered).toBe(true);
    // me.lid is normalized to the @lid domain (like signalIdentities), not left
    // as the raw @s.whatsapp.net JID the extractor hands over.
    expect(creds.me).toEqual({
      id: "551101234567:12@s.whatsapp.net",
      name: "Alice",
      lid: "551101234567@lid",
    });
  });

  it("passes advSecretKey through as a base64 string, not a Buffer", () => {
    const creds = mapSessionToCreds(baseSession());
    expect(creds.advSecretKey).toBe(b64("adv-secret"));
  });

  it("maps the ADV signed device identity fields to Buffers", () => {
    const creds = mapSessionToCreds(baseSession());
    expect(creds.account?.details).toEqual(Buffer.from("acc-details"));
    expect(creds.account?.accountSignatureKey).toEqual(
      Buffer.from("acc-sig-key"),
    );
    expect(creds.account?.accountSignature).toEqual(Buffer.from("acc-sig"));
    expect(creds.account?.deviceSignature).toEqual(Buffer.from("dev-sig"));
  });

  it("builds the self signalIdentity from lid with the 0x05 prefix", () => {
    const creds = mapSessionToCreds(baseSession());
    expect(creds.signalIdentities).toHaveLength(1);
    const identity = creds.signalIdentities![0];
    expect(identity.identifier).toEqual({
      name: "551101234567@lid",
      deviceId: 0,
    });
    expect(identity.identifierKey).toEqual(
      Buffer.concat([Buffer.from([5]), Buffer.from("acc-sig-key")]),
    );
  });

  it("omits signalIdentities when there is no lid", () => {
    const session = { ...baseSession(), lid: undefined };
    const creds = mapSessionToCreds(session);
    expect(creds.signalIdentities).toEqual([]);
  });

  it("maps a nested signedPreKey when present", () => {
    const creds = mapSessionToCreds(baseSession());
    expect(creds.signedPreKey.keyId).toBe(7);
    expect(creds.signedPreKey.keyPair.private).toEqual(Buffer.from("spk-priv"));
    expect(creds.signedPreKey.signature).toEqual(Buffer.from("spk-sig"));
  });

  it("falls back to the default signedPreKey when omitted", () => {
    const session = { ...baseSession(), signedPreKey: undefined };
    const creds = mapSessionToCreds(session);
    // The provided key (keyId 7) must not be used; initAuthCreds' default is.
    expect(creds.signedPreKey.keyId).not.toBe(7);
    expect(creds.signedPreKey.keyPair).toBeDefined();
  });

  it("maps routingInfo to a Buffer only when present", () => {
    const withRouting = mapSessionToCreds({
      ...baseSession(),
      routingInfo: b64("route"),
    });
    expect(withRouting.routingInfo).toEqual(Buffer.from("route"));
    const withoutRouting = mapSessionToCreds(baseSession());
    expect(withoutRouting.routingInfo).toBeUndefined();
  });
});
