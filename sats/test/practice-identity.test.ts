/**
 * A practice circle belongs to the identity that created it.
 *
 * The guided practice flow creates a circle and then has you join it. When a guest key (or an
 * extension) is connected, both requests must be signed by that key: creation used to go through
 * the throwaway demo identity, so the seat you joined was a different member from the circle's
 * creator and every later step (pay, settle, payout) talked about a stranger. These tests drive the
 * real HTTP API with guest signatures, and keep the no-key judge path working too.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKeyHex, getPublicKeyHex, signEvent } from '../public/vendor/guest-nostr.js';
import { npubFromPubkey } from '../src/nostr.ts';

const PORT = 8796;
const BASE = `http://localhost:${PORT}`;
// Valid shape, unreachable wallet: the practice flow must not need the wallet at all.
const DUMMY_NWC = `nostr+walletconnect://${'a'.repeat(64)}?relay=wss://relay.invalid&secret=${'b'.repeat(64)}`;

// The config the practice page sends.
const CONFIG = {
  contributionSats: 21,
  size: 4,
  roundSeconds: 900,
  joinWindowSeconds: 86400,
  collateralSats: 21,
  bondBps: 0,
  maxDiscountBps: 0,
  mode: 'fixed',
};

let child: ReturnType<typeof spawn> | undefined;
let dataDir = '';

async function waitForHealth(timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('the coordinator did not start');
}

async function post(path: string, body: unknown = {}): Promise<{ status: number; body: Record<string, any> }> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

/** The same event the browser's guest signer produces for each action. */
function guestSign(secret: string, action: string, circleId: string | null, payload: Record<string, unknown> = {}) {
  return signEvent(
    {
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['action', action], ...(circleId ? [['circle', circleId]] : [])],
      content: JSON.stringify(payload),
    },
    secret,
  );
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zappot-practice-'));
  child = spawn(process.execPath, ['src/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      DEMO_MODE: '1',
      NWC_URI: DUMMY_NWC,
      // Nothing may reach out to a relay here, so announcements fail fast and stay local.
      NOSTR_RELAYS: 'wss://127.0.0.1:1',
    },
    stdio: 'ignore',
  });
  await waitForHealth();
});

after(() => {
  child?.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test('a guest-signed practice circle seats the guest key that joins it', async () => {
  const secret = generateSecretKeyHex();
  const pubkey = getPublicKeyHex(secret);
  const npub = npubFromPubkey(pubkey);

  // A demo identity is offered in the same request, exactly as the browser did while the bug was
  // live: the signature must win, or the creator is somebody else entirely.
  const stale = (await post('/api/demo/identity')).body;
  const created = await post('/api/circles', {
    name: 'Practice circle',
    config: CONFIG,
    demo: true,
    demoId: stale.demoId,
    event: guestSign(secret, 'create', null, { name: 'Practice circle', config: CONFIG }),
  });
  assert.equal(created.status, 201);
  const id = created.body.circle.id as string;
  assert.equal(created.body.circle.demo, true, 'it is still a practice circle');
  assert.equal(created.body.circle.creatorNpub, npub, 'the guest key created the circle');
  assert.notEqual(created.body.circle.creatorNpub, stale.npub);

  const joined = await post(`/api/circles/${id}/join`, { event: guestSign(secret, 'join', id) });
  assert.equal(joined.status, 200);
  const seat = joined.body.circle.members.find((m: any) => m.npub === npub);
  assert.ok(seat, 'the guest key holds the seat it joined');
  assert.equal(joined.body.circle.members.filter((m: any) => m.npub === npub).length, 1);
  assert.ok(
    !joined.body.circle.members.some((m: any) => m.npub === stale.npub),
    'the demo identity is not a member of the guest key’s circle',
  );

  // And the seat is the one that pays, so the rest of the guided flow stays on one identity.
  assert.equal((await post(`/api/circles/${id}/demo`, { join: CONFIG.size - 1 })).status, 200);
  const paid = await post(`/api/circles/${id}/contribute`, {
    event: guestSign(secret, 'contribute', id, { record: true }),
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.simulated, true);
  assert.ok(paid.body.circle.paid[String(paid.body.circle.currentRound)].includes(npub));
  assert.equal(paid.body.circle.members.find((m: any) => m.npub === npub).onTime, 1);
});

test('a practice circle runs an auction: a bot bids, the member outbids it', async () => {
  const secret = generateSecretKeyHex();
  const npub = npubFromPubkey(getPublicKeyHex(secret));
  const config = { ...CONFIG, mode: 'auction', maxDiscountBps: 1000 };
  const created = await post('/api/circles', {
    name: 'Auction practice',
    config,
    demo: true,
    event: guestSign(secret, 'create', null, { name: 'Auction practice', config }),
  });
  assert.equal(created.status, 201);
  const id = created.body.circle.id as string;
  assert.equal(created.body.circle.config.mode, 'auction');
  assert.equal(created.body.circle.maxDiscountSats, 8, 'the cap is 10% of the 84-sat pot');

  assert.equal((await post(`/api/circles/${id}/join`, { event: guestSign(secret, 'join', id) })).status, 200);
  assert.equal((await post(`/api/circles/${id}/demo`, { join: CONFIG.size - 1 })).status, 200);
  await post(`/api/circles/${id}/contribute`, { event: guestSign(secret, 'contribute', id, { record: true }) });

  // A simulated member opens the bidding, then the visitor has to beat it — the whole point of the
  // auction step in the practice run. A bot can only bid once it has paid its round.
  assert.equal((await post(`/api/circles/${id}/demo`, { pay: true })).status, 200);
  assert.equal((await post(`/api/circles/${id}/demo`, { bid: true })).status, 200);
  const opened = (await (await fetch(`${BASE}/api/circles/${id}`)).json()) as Record<string, any>;
  const botBid = opened.circle.topDiscount['1'];
  assert.ok(botBid > 0, 'the bot placed an opening bid');

  const mine = await post(`/api/circles/${id}/bid`, {
    event: guestSign(secret, 'bid', id, { discountSats: botBid + 1 }),
  });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.circle.topBidder['1'], npub);
  assert.equal(mine.body.circle.topDiscount['1'], botBid + 1);

  // A bid over the cap is refused, so the practice cannot teach a rule the coordinator would break.
  const tooHigh = await post(`/api/circles/${id}/bid`, {
    event: guestSign(secret, 'bid', id, { discountSats: 9 }),
  });
  assert.equal(tooHigh.status, 400);
  assert.match(String(tooHigh.body.message), /above what this circle allows/i);
});

test('a visitor with no key still creates and joins a practice circle with the demo identity', async () => {
  const who = (await post('/api/demo/identity')).body;
  const created = await post('/api/circles', {
    name: 'Practice circle',
    config: CONFIG,
    demo: true,
    demoId: who.demoId,
  });
  assert.equal(created.status, 201);
  const id = created.body.circle.id as string;
  assert.equal(created.body.circle.creatorNpub, who.npub);

  const joined = await post(`/api/circles/${id}/join`, { demoId: who.demoId });
  assert.equal(joined.status, 200);
  assert.ok(joined.body.circle.members.some((m: any) => m.npub === who.npub));
});
