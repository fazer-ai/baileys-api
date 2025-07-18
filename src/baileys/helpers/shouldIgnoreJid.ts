import {
  isJidBot,
  isJidBroadcast,
  isJidGroup,
  isJidMetaIa,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
} from "@whiskeysockets/baileys";
import config from "@/config";

export function shouldIgnoreJid(jid: string): boolean {
  const {
    ignoreGroupMessages,
    ignoreStatusMessages,
    ignoreBroadcastMessages,
    ignoreNewsletterMessages,
    ignoreBotMessages,
    ignoreMetaAiMessages,
  } = config.baileys;

  if ((isJidGroup(jid) || isLidUser(jid)) && ignoreGroupMessages) {
    return true;
  }
  if (isJidStatusBroadcast(jid) && ignoreStatusMessages) {
    return true;
  }
  if (
    isJidBroadcast(jid) &&
    !isJidStatusBroadcast(jid) &&
    ignoreBroadcastMessages
  ) {
    return true;
  }
  if (isJidNewsletter(jid) && ignoreNewsletterMessages) {
    return true;
  }
  if (isJidBot(jid) && ignoreBotMessages) {
    return true;
  }
  if (isJidMetaIa(jid) && ignoreMetaAiMessages) {
    return true;
  }
  return false;
}
