import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CircleError,
  balanceSheet,
  bid,
  cancel,
  contribute,
  createCircle,
  join,
  owedSats,
  settleRound,
  takePayout,
  validateConfig,
  type Circle,
  type CircleConfig,
} from '../src/circle.ts';

const T0 = 1_700_000_000;

function cfg(over: Partial<CircleConfig> = {}): CircleConfig {
  return {
    contributionSats: 1000,
    size: 3,
    roundSeconds: 60,
    joinWindowSeconds: 3600,
    collateralSats: 500,
    bondBps: 0,
    maxDiscountBps: 0,
    mode: 'fixed',
    ...over,
  };
}

function circleOf(over: Partial<CircleConfig> = {}): Circle {
  return createCircle({ id: 'c1', name: 'Test circle', creatorNpub: 'npub1creator', config: cfg(over), now: T0 });
}

function joined(c: Circle, names: string[]): Circle {
  for (const n of names) join(c, n, T0 + 1);
  return c;
}

function everyonePays(c: Circle, at: number): void {
  for (const m of c.members) contribute(c, m.npub, at);
}

test('a full fixed-order cycle pays out every pot and strands nothing', () => {
  const c = joined(circleOf(), ['a', 'b', 'c']);
  assert.equal(c.phase, 'active');
  assert.equal(c.currentRound, 1);

  for (let r = 1; r <= 3; r += 1) {
    everyonePays(c, c.startedAt + r * 60 - 10);
    settleRound(c, c.startedAt + r * 60 - 5);
  }

  assert.equal(c.phase, 'completed');
  assert.equal(c.results.length, 3);
  assert.deepEqual(
    c.results.map((r) => r.winner),
    ['a', 'b', 'c'],
  );
  // Everyone put in 3,000 and took one 3,000 pot; collateral comes back whole.
  for (const m of c.members) {
    assert.equal(m.contributed, 3000);
    assert.equal(m.received, 3000);
    assert.equal(m.collateralLeft, 500);
    assert.equal(owedSats(c, m.npub), 3500);
  }
  const sheet = balanceSheet(c);
  assert.equal(sheet.strandedSats, 0);
  assert.equal(sheet.inSats - sheet.outSats, sheet.owedSats);
});

test('a missed round is taken from collateral, and a member who cannot cover it defaults', () => {
  const c = joined(circleOf(), ['a', 'b', 'c']);
  contribute(c, 'b', c.startedAt + 5);
  contribute(c, 'c', c.startedAt + 5);

  // a never pays; the round has to be past its deadline to settle.
  settleRound(c, c.startedAt + 61);

  const a = c.members.find((m) => m.npub === 'a')!;
  assert.equal(a.missed, 1);
  assert.equal(a.collateralLeft, 0);
  assert.equal(a.defaulted, true, 'collateral of 500 cannot cover a 1000 contribution');
  assert.equal(c.results[0].pot, 2500);
  assert.equal(c.results[0].winner, 'b', 'a defaulted, so the pot skips to the next member');
  const sheet = balanceSheet(c);
  assert.equal(sheet.strandedSats, 0);
});

test("a winner's bond is capped at what they still owe", () => {
  const c = joined(circleOf({ bondBps: 5000 }), ['a', 'b', 'c']);
  everyonePays(c, 1, c.startedAt + 5);
  const outcome = settleRound(c, c.startedAt + 10);

  // Pot 3000, bond 50% would be 1500, but a still owes 2 rounds x 1000 = 2000, so 1500 is held.
  assert.equal(outcome.result.bondHeld, 1500);
  assert.equal(outcome.result.payout, 1500);
  const a = c.members.find((m) => m.npub === 'a')!;
  assert.equal(a.bond, 1500);
  assert.equal(a.claimable, 1500);
  assert.equal(balanceSheet(c).strandedSats, 0);
});

test('an auction discount is shared by everyone else, with no dust stranded', () => {
  const c = joined(circleOf({ mode: 'auction', maxDiscountBps: 3000 }), ['a', 'b', 'c']);
  everyonePays(c, c.startedAt + 5);
  bid(c, 'b', 100, c.startedAt + 6);
  const outcome = settleRound(c, c.startedAt + 61);

  assert.equal(outcome.result.winner, 'b');
  assert.equal(outcome.result.discount, 100);
  assert.equal(outcome.result.payout, 2900);
  assert.equal(c.members.find((m) => m.npub === 'a')!.claimable, 50);
  assert.equal(c.members.find((m) => m.npub === 'c')!.claimable, 50);
  assert.equal(balanceSheet(c).strandedSats, 0);
});

test('a member who already took a pot cannot bid again', () => {
  const c = joined(circleOf({ mode: 'auction', maxDiscountBps: 3000 }), ['a', 'b', 'c']);
  everyonePays(c, c.startedAt + 5);
  bid(c, 'a', 100, c.startedAt + 6);
  assert.equal(settleRound(c, c.startedAt + 61).result.winner, 'a');

  // Round 2: everyone pays again, and a tries to take a second pot.
  everyonePays(c, c.startedAt + 65);
  assert.throws(
    () => bid(c, 'a', 50, c.startedAt + 66),
    (e: unknown) => e instanceof CircleError && e.code === 'NotEligible',
  );
});

test('you must pay before you can bid', () => {
  const c = joined(circleOf({ mode: 'auction', maxDiscountBps: 3000 }), ['a', 'b', 'c']);
  assert.throws(
    () => bid(c, 'b', 100, c.startedAt + 5),
    (e: unknown) => e instanceof CircleError && e.code === 'MustContributeFirst',
  );
});

test('bids must beat the current best and stay under the cap', () => {
  const c = joined(circleOf({ mode: 'auction', maxDiscountBps: 3000 }), ['a', 'b', 'c']);
  everyonePays(c, c.startedAt + 5);

  bid(c, 'a', 100, c.startedAt + 6);
  assert.throws(
    () => bid(c, 'b', 100, c.startedAt + 7),
    (e: unknown) => e instanceof CircleError && e.code === 'BidTooLow',
  );
  assert.throws(
    () => bid(c, 'b', 901, c.startedAt + 7),
    (e: unknown) => e instanceof CircleError && e.code === 'DiscountTooHigh',
  );
  bid(c, 'b', 150, c.startedAt + 8);
  assert.equal(c.topBidder['1'], 'b');
  assert.equal(c.topDiscount['1'], 150);
});

test('an auction round cannot close before its deadline', () => {
  const c = joined(circleOf({ mode: 'auction', maxDiscountBps: 3000 }), ['a', 'b', 'c']);
  everyonePays(c, c.startedAt + 5);
  assert.throws(
    () => settleRound(c, c.startedAt + 10),
    (e: unknown) => e instanceof CircleError && e.code === 'RoundStillOpen',
  );
});

test('a payout must match what is owed, to the satoshi', () => {
  const c = joined(circleOf(), ['a', 'b', 'c']);
  everyonePays(c, c.startedAt + 5);
  settleRound(c, c.startedAt + 10);

  const a = c.members.find((m) => m.npub === 'a')!;
  assert.equal(owedSats(c, 'a'), 3000);
  assert.throws(
    () => takePayout(c, 'a', 3001, c.startedAt + 20),
    (e: unknown) => e instanceof CircleError && e.code === 'BadAmount',
  );
  takePayout(c, 'a', 3000, c.startedAt + 20);
  assert.equal(a.claimable, 0);
  assert.equal(a.withdrawnSats, 3000);
  // The pot is paid, but the collateral is still locked: it protects the two rounds a has not paid for yet.
  assert.equal(a.collateralLeft, 500);
  assert.equal(owedSats(c, 'a'), 0, 'nothing more can be taken until the circle ends');

  // Finish the circle, then the collateral comes back.
  everyonePays(c, c.startedAt + 65);
  settleRound(c, c.startedAt + 70);
  everyonePays(c, c.startedAt + 125);
  settleRound(c, c.startedAt + 130);
  assert.equal(c.phase, 'completed');
  assert.equal(owedSats(c, 'a'), 500);
  takePayout(c, 'a', 500, c.startedAt + 140);
  assert.equal(a.collateralLeft, 0);
  assert.equal(balanceSheet(c).strandedSats, 0);
});

test('a circle that never fills can be cancelled and refunds collateral', () => {
  const c = circleOf();
  join(c, 'a', T0 + 1);
  cancel(c, 'npub1creator', T0 + 2);
  assert.equal(c.phase, 'cancelled');
  assert.equal(owedSats(c, 'a'), 500);
  takePayout(c, 'a', 500, T0 + 3);
  assert.equal(balanceSheet(c).strandedSats, 0);
});

test('only the creator can cancel before the window closes', () => {
  const c = circleOf();
  join(c, 'a', T0 + 1);
  assert.throws(
    () => cancel(c, 'b', T0 + 2),
    (e: unknown) => e instanceof CircleError && e.code === 'NotCancellable',
  );
  // After the join window anyone can close a circle that never filled.
  cancel(c, 'b', T0 + 3601);
  assert.equal(c.phase, 'cancelled');
});

test('configuration is validated before a circle exists', () => {
  const bad: Partial<CircleConfig>[] = [
    { size: 1 },
    { size: 21 },
    { contributionSats: 0 },
    { roundSeconds: 30 },
    { bondBps: 5001 },
    { maxDiscountBps: 3001 },
    { mode: 'fixed', maxDiscountBps: 100 },
    { collateralSats: -1 },
  ];
  for (const over of bad) {
    assert.throws(
      () => validateConfig(cfg(over)),
      (e: unknown) => e instanceof CircleError && e.code === 'BadConfig',
      JSON.stringify(over),
    );
  }
  assert.doesNotThrow(() => validateConfig(cfg()));
});

test('joining twice, joining a started circle and filling a full circle are refused', () => {
  const c = joined(circleOf(), ['a', 'b', 'c']);
  assert.throws(
    () => join(c, 'a', T0 + 2),
    (e: unknown) => e instanceof CircleError,
  );
  assert.throws(
    () => join(c, 'd', T0 + 2),
    (e: unknown) => e instanceof CircleError && e.code === 'WrongPhase',
  );
});
