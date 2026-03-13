import { beforeEach, describe, expect, it } from "bun:test";
import config from "@/config";
import { shouldIgnoreJid } from "./shouldIgnoreJid";

describe("shouldIgnoreJid", () => {
  beforeEach(() => {
    // Reset to defaults before each test
    config.baileys.ignoreGroupMessages = false;
    config.baileys.ignoreStatusMessages = true;
    config.baileys.ignoreBroadcastMessages = true;
    config.baileys.ignoreNewsletterMessages = true;
    config.baileys.ignoreBotMessages = true;
    config.baileys.ignoreMetaAiMessages = true;
  });

  describe("group messages", () => {
    const groupJid = "123456789@g.us";

    it("ignores group JIDs when ignoreGroupMessages is true", () => {
      config.baileys.ignoreGroupMessages = true;
      expect(shouldIgnoreJid(groupJid)).toBe(true);
    });

    it("does not ignore group JIDs when ignoreGroupMessages is false", () => {
      config.baileys.ignoreGroupMessages = false;
      expect(shouldIgnoreJid(groupJid)).toBe(false);
    });
  });

  describe("status broadcast messages", () => {
    const statusJid = "status@broadcast";

    it("ignores status broadcast JIDs when ignoreStatusMessages is true", () => {
      config.baileys.ignoreStatusMessages = true;
      expect(shouldIgnoreJid(statusJid)).toBe(true);
    });

    it("does not ignore status broadcast JIDs when ignoreStatusMessages is false", () => {
      config.baileys.ignoreStatusMessages = false;
      // Status broadcast is also a broadcast, so check broadcast config too
      config.baileys.ignoreBroadcastMessages = false;
      expect(shouldIgnoreJid(statusJid)).toBe(false);
    });
  });

  describe("broadcast messages (non-status)", () => {
    // A regular broadcast JID that is NOT status@broadcast
    const broadcastJid = "12345@broadcast";

    it("ignores broadcast JIDs when ignoreBroadcastMessages is true", () => {
      config.baileys.ignoreBroadcastMessages = true;
      expect(shouldIgnoreJid(broadcastJid)).toBe(true);
    });

    it("does not ignore broadcast JIDs when ignoreBroadcastMessages is false", () => {
      config.baileys.ignoreBroadcastMessages = false;
      expect(shouldIgnoreJid(broadcastJid)).toBe(false);
    });
  });

  describe("newsletter messages", () => {
    const newsletterJid = "120363012345678901@newsletter";

    it("ignores newsletter JIDs when ignoreNewsletterMessages is true", () => {
      config.baileys.ignoreNewsletterMessages = true;
      expect(shouldIgnoreJid(newsletterJid)).toBe(true);
    });

    it("does not ignore newsletter JIDs when ignoreNewsletterMessages is false", () => {
      config.baileys.ignoreNewsletterMessages = false;
      expect(shouldIgnoreJid(newsletterJid)).toBe(false);
    });
  });

  describe("regular user JIDs", () => {
    const userJid = "5511999999999@s.whatsapp.net";

    it("does not ignore regular user JIDs regardless of config", () => {
      expect(shouldIgnoreJid(userJid)).toBe(false);
    });
  });

  describe("when all filters are disabled", () => {
    it("does not ignore any JID type", () => {
      config.baileys.ignoreGroupMessages = false;
      config.baileys.ignoreStatusMessages = false;
      config.baileys.ignoreBroadcastMessages = false;
      config.baileys.ignoreNewsletterMessages = false;
      config.baileys.ignoreBotMessages = false;
      config.baileys.ignoreMetaAiMessages = false;

      expect(shouldIgnoreJid("123456789@g.us")).toBe(false);
      expect(shouldIgnoreJid("status@broadcast")).toBe(false);
      expect(shouldIgnoreJid("12345@broadcast")).toBe(false);
      expect(shouldIgnoreJid("120363012345678901@newsletter")).toBe(false);
      expect(shouldIgnoreJid("5511999999999@s.whatsapp.net")).toBe(false);
    });
  });
});
