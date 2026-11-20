/**
 * The "record it instead" fallback, exercised over the real HTTP surface.
 *
 * A visitor with no sats must be able to finish a practise circle, and that must never be possible
 * in a circle that is supposed to move real sats. The server is started with a syntactically valid
 * but unreachable NWC string so the wallet is "configured": if the record path ever fell through to
 * the wallet, these tests would hang instead of passing.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

const PORT = 8797;
const BASE = `http://localhost:${PORT}`;
const DUMMY_NWC = `nostr+walletconnect://${'a'.repeat(64)}?relay=wss://relay.invalid&secret=${'b'.repeat(64)}`;

const CONFIG = {
  contributionSats: 21,
  size: 4,
  roundSeconds: 900,
  joinWindowSeconds: 86400,
  collateralSats: 21,
  bondBps: 500,
  maxDiscountBps: 0,
  mode: 'join',
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

async function get(path: string): Promise<Record<string, any>> {
  return (await (await fetch(BASE + path)).json()) as Record<string, any>;
}

/** The same NIP-98 style event the browser's extension signs. */
function sign(secret: Uint8Array, action: string, circleId: string | null, payload: Record<string, unknown> = {}) {
  return finalizeEvent(
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
  dataDir = mkdtempSync(join(tmpdir(), 'zappot-record-'));
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

test('a practice circle records a contribution and a payout without moving sats', async () => {
  const who = (await post('/api/demo/identity')).body;
  const created = await post('/api/circles', {
    name: 'Record fallback',
    config: CONFIG,
    demo: true,
    demoId: who.demoId,
  });
  assert.equal(created.status, 201);
  const id = created.body.circle.id as string;

  assert.equal((await post(`/api/circles/${id}/join`, { demoId: who.demoId })).status, 200);
  assert.equal((await post(`/api/circles/${id}/demo`, { demoId: who.demoId, join: 3 })).status, 200);

  const recorded = await post(`/api/circles/${id}/contribute`, { demoId: who.demoId, record: true });
  assert.equal(recorded.status, 200);
  assert.equal(recorded.body.simulated, true, 'the contribution must be marked as recorded');
  assert.equal(recorded.body.invoice, undefined, 'recording must not create an invoice');
  assert.equal(recorded.body.onTime, true);

  await post(`/api/circles/${id}/demo`, { demoId: who.demoId, pay: true });
  assert.equal((await post(`/api/circles/${id}/settle`, { demoId: who.demoId })).status, 200);

  const circle = await get(`/api/circles/${id}`);
  const me = circle.circle.members.find((m: any) => m.npub === who.npub);
  assert.ok(me.claimable > 0, 'the round should have left something owed');

  const payout = await post(`/api/circles/${id}/payout`, { demoId: who.demoId, record: true });
  assert.equal(payout.status, 200);
  assert.equal(payout.body.simulated, true, 'the payout must be marked as recorded');
  assert.equal(payout.body.paidSats, me.claimable);
});

test('a real circle refuses to record a contribution instead of moving sats', async () => {
  const secret = generateSecretKey();
  const created = await post('/api/circles', {
    name: 'Real circle',
    config: CONFIG,
    event: sign(secret, 'create', null, { name: 'Real circle', config: CONFIG }),
  });
  assert.equal(created.status, 201);
  const id = created.body.circle.id as string;

  // The guard only runs on a running circle, so fill every seat with a signed member first.
  assert.equal((await post(`/api/circles/${id}/join`, { event: sign(secret, 'join', id) })).status, 200);
  for (let i = 0; i < CONFIG.size - 1; i++) {
    const other = generateSecretKey();
    assert.equal((await post(`/api/circles/${id}/join`, { event: sign(other, 'join', id) })).status, 200);
  }
  const running = await get(`/api/circles/${id}`);
  assert.equal(running.circle.phase, 'active');

  const refused = await post(`/api/circles/${id}/contribute`, {
    event: sign(secret, 'contribute', id),
    record: true,
  });
  assert.equal(refused.status, 400);
  assert.match(String(refused.body.message), /practice circle/i);
  assert.notEqual(refused.body.simulated, true);

  // Nothing is owed in a circle that never took a payment, so the payout is refused too — and it is
  // never booked as a recorded payout.
  const refusedPayout = await post(`/api/circles/${id}/payout`, {
    event: sign(secret, 'payout', id),
    record: true,
  });
  assert.equal(refusedPayout.status, 400);
  assert.notEqual(refusedPayout.body.simulated, true);
});
