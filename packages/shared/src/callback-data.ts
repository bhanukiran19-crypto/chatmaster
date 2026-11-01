/**
 * Inline-button `callback_data` codec. Telegram caps callback_data at 64 bytes;
 * `r:<uuid>` is 38 bytes. The payload is attacker-controlled (any client can
 * send arbitrary callback data), so decoding is strict and the worker still
 * verifies the referenced reply is reachable from a button it owns.
 */
const REPLY_PREFIX = 'r:';
/** Prefix emitted by the first webhook release; still accepted for in-flight keyboards. */
const LEGACY_REPLY_PREFIX = 'reply:';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MAX_CALLBACK_DATA_BYTES = 64;

export function encodeReplyCallbackData(replyId: string): string {
  if (!UUID_RE.test(replyId)) throw new TypeError('replyId must be a UUID');
  return `${REPLY_PREFIX}${replyId.toLowerCase()}`;
}

/** Returns the referenced reply id, or null when the payload is not a reply reference. */
export function decodeReplyCallbackData(data: string | undefined): string | null {
  if (!data || data.length > MAX_CALLBACK_DATA_BYTES) return null;
  let candidate: string;
  if (data.startsWith(REPLY_PREFIX)) candidate = data.slice(REPLY_PREFIX.length);
  else if (data.startsWith(LEGACY_REPLY_PREFIX)) candidate = data.slice(LEGACY_REPLY_PREFIX.length);
  else return null;
  return UUID_RE.test(candidate) ? candidate.toLowerCase() : null;
}
