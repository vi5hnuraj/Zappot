/**
 * Proving that the person acting is the owner of the Nostr identity they claim.
 *
 * Every mutating member action (join, bid, payout, withdraw) carries a signed event. The browser
 * signs with a NIP-07 extension, so the coordinator never sees a private key. The event binds the
 * action and the circle, carries the payload in its content, and must be fresh — a captured event
 * cannot be replayed onto another circle or reused after the window.
 */

import { getEventHash, verifyEvent } from 'nostr-tools';

/** NIP-98 style HTTP auth event. */
export const AUTH_KIND = 27235;
export const AUTH_TOLERANCE_SECONDS = 300;

export type SignedAuthEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

export type VerifiedAuth = {
  pubkey: string;
  payload: Record<string, unknown>;
};

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

function tag(event: SignedAuthEvent, name: string): string | undefined {
  const hit = event.tags.find((t) => Array.isArray(t) && t[0] === name);
  return hit?.[1];
}

const seen = new Map<string, number>();

function rememberNonce(id: string, now: number): void {
  for (const [key, at] of seen) {
    if (now - at > AUTH_TOLERANCE_SECONDS * 2) seen.delete(key);
  }
  if (seen.has(id)) throw new AuthError('this request was already used; sign it again');
  seen.set(id, now);
}

/**
 * Check a signed event against the action and circle it claims to authorise, and return the
 * payload it carries. `now` is unix seconds.
 */
export function verifyAuth(
  event: unknown,
  expected: { action: string; circleId?: string; now: number; pubkey?: string },
): VerifiedAuth {
  if (!event || typeof event !== 'object') throw new AuthError('a signature is required');
  const e = event as SignedAuthEvent;

  if (e.kind !== AUTH_KIND) throw new AuthError('wrong signature kind');
  if (typeof e.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(e.pubkey)) throw new AuthError('malformed public key');
  if (expected.pubkey && e.pubkey !== expected.pubkey) {
    throw new AuthError('this signature belongs to a different identity');
  }
  if (typeof e.created_at !== 'number' || Math.abs(expected.now - e.created_at) > AUTH_TOLERANCE_SECONDS) {
    throw new AuthError('this signature has expired; sign the request again');
  }
  if (tag(e, 'action') !== expected.action) throw new AuthError('this signature is for a different action');
  if (expected.circleId && tag(e, 'circle') !== expected.circleId) {
    throw new AuthError('this signature is for a different circle');
  }

  // `verifyEvent` checks the signature against the event's `id`, but it does not recompute that id
  // from the fields. Without this check, anyone could keep a valid id and signature and rewrite the
  // content — and the content is the payload. So hash the event ourselves and require a match.
  let hashMatches = false;
  try {
    hashMatches = getEventHash(e as Parameters<typeof getEventHash>[0]) === e.id;
  } catch {
    hashMatches = false;
  }
  if (!hashMatches) throw new AuthError('the signature does not match the request');

  let verified = false;
  try {
    verified = verifyEvent(e as Parameters<typeof verifyEvent>[0]);
  } catch {
    verified = false;
  }
  if (!verified) throw new AuthError('the signature does not match the request');

  let payload: Record<string, unknown> = {};
  if (e.content.trim()) {
    try {
      const parsed = JSON.parse(e.content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    } catch {
      throw new AuthError('the signed payload is not valid JSON');
    }
  }

  rememberNonce(e.id, expected.now);
  return { pubkey: e.pubkey, payload };
}
