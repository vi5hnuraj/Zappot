/**
 * The guest signer is a build artefact (`public/vendor/guest-nostr.js`, produced from
 * `browser/guest-signer.ts` by `npm run build:browser`). These tests keep the artefact honest: if the
 * bundle is stale or the key format drifts, the server would start rejecting guest signatures with no
 * obvious symptom in the browser, so check that a signed event actually passes `verifyAuth`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKeyHex, getPublicKeyHex, signEvent } from '../public/vendor/guest-nostr.js';
import { verifyAuth } from '../src/auth.ts';

test('a guest key signs an event the coordinator accepts', () => {
  const secret = generateSecretKeyHex();
  assert.match(secret, /^[0-9a-f]{64}$/);

  const pubkey = getPublicKeyHex(secret);
  assert.match(pubkey, /^[0-9a-f]{64}$/);

  const now = Math.floor(Date.now() / 1000);
  const event = signEvent(
    {
      kind: 27235,
      created_at: now,
      tags: [
        ['action', 'join'],
        ['circle', 'abc123'],
      ],
      content: JSON.stringify({ note: 'guest' }),
    },
    secret,
  );

  assert.equal(event.pubkey, pubkey);
  assert.match(event.sig, /^[0-9a-f]{128}$/);

  // The same verification a real request goes through: signature, action, circle and freshness.
  const verified = verifyAuth(event, { action: 'join', circleId: 'abc123', now });
  assert.equal(verified.pubkey, pubkey);
  assert.deepEqual(verified.payload, { note: 'guest' });
});

test('a guest signature is bound to its action and circle', () => {
  const secret = generateSecretKeyHex();
  const now = Math.floor(Date.now() / 1000);
  const event = signEvent(
    { kind: 27235, created_at: now, tags: [['action', 'join'], ['circle', 'abc123']], content: '{}' },
    secret,
  );

  assert.throws(() => verifyAuth(event, { action: 'payout', circleId: 'abc123', now }), /different action/);
  assert.throws(() => verifyAuth(event, { action: 'join', circleId: 'zzz999', now }), /different circle/);
});
