import { jidNormalizedUser, type WAMessageKey } from "@whiskeysockets/baileys";
import type { MessageEditSenders } from "@/baileys/helpers/decryptMessageEdit";

export interface OwnJids {
  /** socket.user.id — phone-number form for a paired account. */
  id?: string | null;
  /** socket.user.lid — the same account addressed by its LID. */
  lid?: string | null;
}

function normalize(jid: string | null | undefined): string | null {
  if (!jid) {
    return null;
  }
  try {
    // Strips the device suffix ("…:58@lid"), which is never part of the
    // derivation — whatsmeow calls the same normalization ToNonAD().
    return jidNormalizedUser(jid) || null;
  } catch {
    return null;
  }
}

function unique(jids: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const jid of jids) {
    const normalized = normalize(jid);
    if (normalized && !out.includes(normalized)) {
      out.push(normalized);
    }
  }
  return out;
}

/**
 * The JIDs a message's author may be addressed by, most likely first.
 *
 * Two of them, not one, because a chat mid-LID-migration reports the same
 * person both as `<lid>@lid` and as `<phone>@s.whatsapp.net`, and the key
 * derivation is over whichever string WhatsApp itself used.
 */
export function messageAuthorJids(key: WAMessageKey, me: OwnJids): string[] {
  if (key.fromMe) {
    return unique([me.lid, me.id]);
  }
  return unique([
    key.participant || key.remoteJid,
    key.participantAlt || key.remoteJidAlt,
  ]);
}

/**
 * Candidate (original author, editor) pairs for a message edit, in the order
 * they are worth trying.
 *
 * `targetMessageKey.fromMe` is written from the EDITOR's point of view: true
 * means they are editing their own message, so the original author is the
 * editor. False means they are editing ours, and the key's remoteJid is then
 * how they address us. `storedSenders` are the JIDs we filed the original
 * under and act as the fallback for when that reasoning meets a JID form we
 * did not predict.
 */
export function messageEditSenderCandidates({
  editKey,
  targetKey,
  me,
  storedSenders = [],
}: {
  editKey: WAMessageKey;
  targetKey: WAMessageKey;
  me: OwnJids;
  storedSenders?: string[];
}): MessageEditSenders[] {
  const editSenders = messageAuthorJids(editKey, me);
  const origSenders = unique([
    ...(targetKey.fromMe
      ? editSenders
      : [targetKey.participant || targetKey.remoteJid]),
    ...storedSenders,
  ]);

  const candidates: MessageEditSenders[] = [];
  for (const origMsgSender of origSenders) {
    for (const editSender of editSenders) {
      candidates.push({ origMsgSender, editSender });
    }
  }
  return candidates;
}
