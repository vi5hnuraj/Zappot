import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { AUTH_KIND, AuthError, verifyAuth } from '../src/auth.ts';

const NOW = 1_700_000_000;
const sk = generateSecretKey();
const pubkey = getPublicKey(sk);

let counter = 0;
function signed(over: { action?: string; circle?: string; at?: number; content?: string } = {}) {
  counter += 1;
  return finalizeEvent(
    {
      kind: AUTH_KIND,
      created_at: over.at ?? NOW,
      tags: [
        ['action', over.action ?? 'join'],
        ...(over.circle ? [['circle', over.circle]] : []),
        ['nonce', String(counter)],
      ],
      content: over.content ?? JSON.stringify({ hello: 'world' }),
    },
    sk,
  );
}

test('a signed action is accepted and its payload returned', () => {
  const result = verifyAuth(signed({ circle: 'c1' }), { action: 'join', circleId: 'c1', now: NOW, pubkey });
  assert.equal(result.pubkey, pubkey);
  assert.deepEqual(result.payload, { hello: 'world' });
});

test('a signature for another action or circle is refused', () => {
  assert.throws(
    () => verifyAuth(signed({ action: 'bid', circle: 'c1' }), { action: 'join', circleId: 'c1', now: NOW }),
    (e: unknown) => e instanceof AuthError,
  );
  assert.throws(
    () => verifyAuth(signed({ action: 'join', circle: 'c2' }), { action: 'join', circleId: 'c1', now: NOW }),
    (e: unknown) => e instanceof AuthError,
  );
});

test('a stale signature is refused', () => {
  assert.throws(
    () => verifyAuth(signed({ at: NOW - 3600 }), { action: 'join', now: NOW }),
    (e: unknown) => e instanceof AuthError,
  );
});

test('a tampered payload fails the signature check', () => {
  const event = signed({});
  const forged = { ...event, content: JSON.stringify({ hello: 'a bigger number' }) };
  assert.throws(
    () => verifyAuth(forged, { action: 'join', now: NOW }),
    (e: unknown) => e instanceof AuthError,
  );
});

test('the same request cannot be replayed', () => {
  const event = signed({});
  verifyAuth(event, { action: 'join', now: NOW });
  assert.throws(
    () => verifyAuth(event, { action: 'join', now: NOW }),
    (e: unknown) => e instanceof AuthError,
  );
});

test('a signature from the wrong identity is refused', () => {
  const other = getPublicKey(generateSecretKey());
  assert.throws(
    () => verifyAuth(signed({}), { action: 'join', now: NOW, pubkey: other }),
    (e: unknown) => e instanceof AuthError,
  );
});

test('junk input is refused without throwing an unexpected error', () => {
  for (const junk of [null, undefined, {}, 'event', { kind: 1 }]) {
    assert.throws(
      () => verifyAuth(junk, { action: 'join', now: NOW }),
      (e: unknown) => e instanceof AuthError,
    );
  }
});
