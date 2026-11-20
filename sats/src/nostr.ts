/**
 * Nostr identity and circle announcements.
 *
 * A member is a Nostr key, not an email address: the circle never learns who they are, only that the
 * same key paid in rounds 1 and 2 and took the pot in round 3. The coordinator publishes each
 * circle's state as an addressable note (kind 30078, `d` = circle id), so the group's progress is
 * readable from any Nostr client without trusting this server.
 */

import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import type { Circle } from './circle.ts';

/** Addressable application data: one replaceable note per circle. */
export const CIRCLE_KIND = 30078;
export const APP_TAG = 'potluck-sats';

export type Identity = {
  secretKey: Uint8Array;
  pubkey: string;
  npub: string;
};

export function identityFromSecretKey(secretKey: Uint8Array): Identity {
  const pubkey = getPublicKey(secretKey);
  return { secretKey, pubkey, npub: nip19.npubEncode(pubkey) };
}

export function createIdentity(): Identity {
  return identityFromSecretKey(generateSecretKey());
}

export function identityFromNsec(nsec: string): Identity {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== 'nsec') throw new Error('that is not an nsec');
  return identityFromSecretKey(decoded.data);
}

export function isValidNpub(value: string): boolean {
  try {
    return nip19.decode(value.trim()).type === 'npub';
  } catch {
    return false;
  }
}

/** Accept an npub or a raw hex pubkey and return the hex form. */
export function pubkeyFromNpub(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9a-f]{64}$/.test(trimmed)) return trimmed;
  const decoded = nip19.decode(trimmed);
  if (decoded.type !== 'npub') throw new Error('expected an npub');
  return decoded.data;
}

export function npubFromPubkey(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}

export function shortNpub(npub: string): string {
  return `${npub.slice(0, 10)}…${npub.slice(-4)}`;
}

export function inviteUrl(publicUrl: string, circleId: string): string {
  return `${publicUrl.replace(/\/$/, '')}/#/c/${circleId}`;
}

/** The public summary of a circle. No member keys, no amounts owed per person, no PII. */
export function circleSummary(circle: Circle) {
  return {
    app: APP_TAG,
    id: circle.id,
    name: circle.name,
    phase: circle.phase,
    mode: circle.config.mode,
    contributionSats: circle.config.contributionSats,
    size: circle.config.size,
    roundSeconds: circle.config.roundSeconds,
    collateralSats: circle.config.collateralSats,
    bondBps: circle.config.bondBps,
    currentRound: circle.currentRound,
    memberCount: circle.members.length,
    potSats: circle.config.contributionSats * circle.config.size,
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

export function circleEventTemplate(circle: Circle) {
  return {
    kind: CIRCLE_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', circle.id],
      ['t', APP_TAG],
      ['alt', `Zappot savings circle: ${circle.name}`],
      ['status', circle.phase],
      ['mode', circle.config.mode],
    ],
    content: JSON.stringify(circleSummary(circle)),
  };
}

export type PublishResult = {
  eventId: string;
  accepted: string[];
  rejected: string[];
};

type RelayOutcome = { url: string; ok: boolean };

/**
 * Send one event to one relay over a plain WebSocket and resolve with whether it was accepted.
 *
 * This is deliberately not a pool: a relay pool keeps sockets open and reconnects, and its error
 * path can recurse through `onerror` → `close()` → `onerror` when a relay is unreachable, which
 * crashed the whole coordinator on some Node versions. One socket per publish, closed as soon as the
 * relay answers, cannot do that.
 */
function publishToRelay(url: string, event: { id: string }, timeoutMs: number): Promise<RelayOutcome> {
  return new Promise<RelayOutcome>((resolve) => {
    let settled = false;
    let socket: WebSocket | undefined;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* the socket is already closing; onclose is guarded above */
      }
      resolve({ url, ok });
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    try {
      socket = new WebSocket(url);
    } catch {
      finish(false);
      return;
    }

    socket.onopen = () => {
      try {
        socket?.send(JSON.stringify(['EVENT', event]));
      } catch {
        finish(false);
      }
    };

    socket.onmessage = (message: MessageEvent) => {
      if (typeof message.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        return;
      }
      if (!Array.isArray(parsed) || parsed[0] !== 'OK' || parsed[1] !== event.id) return;
      finish(parsed[2] === true);
    };

    socket.onerror = () => finish(false);
    socket.onclose = () => finish(false);
  });
}

/**
 * Publish the circle's current state to the relays. A relay that refuses is reported, not fatal:
 * Nostr has no single point of failure and the circle keeps running without it.
 */
export async function publishCircle(
  identity: Identity,
  relays: string[],
  circle: Circle,
  timeoutMs = 6000,
): Promise<PublishResult> {
  if (relays.length === 0) return { eventId: '', accepted: [], rejected: [] };
  const event = finalizeEvent(circleEventTemplate(circle), identity.secretKey);
  const outcomes = await Promise.all(relays.map((url) => publishToRelay(url, event, timeoutMs)));
  return {
    eventId: event.id,
    accepted: outcomes.filter((o) => o.ok).map((o) => o.url),
    rejected: outcomes.filter((o) => !o.ok).map((o) => o.url),
  };
}
