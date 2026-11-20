/**
 * The tontine rules, in satoshis.
 *
 * These are the rules of a tontine:
 * collateral instead of trust, a winner's bond, auction or join order, and pull payments. This
 * module is the Lightning settlement path: the numbers are satoshis, and every "credit" here is
 * something the coordinator owes a member and pays over Lightning when they hand it an invoice.
 *
 * It is deliberately I/O free so the rules can be tested without a wallet or a relay.
 */

export const MIN_SIZE = 2;
export const MAX_SIZE = 20;
export const MAX_BOND_BPS = 5_000;
export const MAX_DISCOUNT_BPS = 3_000;

export type Mode = 'fixed' | 'auction';
export type Phase = 'forming' | 'active' | 'completed' | 'cancelled';

export type CircleConfig = {
  contributionSats: number;
  size: number;
  roundSeconds: number;
  joinWindowSeconds: number;
  collateralSats: number;
  bondBps: number;
  maxDiscountBps: number;
  mode: Mode;
};

export type Member = {
  npub: string;
  joinedAt: number;
  won: boolean;
  defaulted: boolean;
  withdrawn: boolean;
  wonRound: number;
  onTime: number;
  missed: number;
  collateralLeft: number;
  bond: number;
  contributed: number;
  received: number;
  claimable: number;
  withdrawnSats: number;
};

export type RoundResult = {
  round: number;
  winner: string | null;
  pot: number;
  discount: number;
  payout: number;
  bondHeld: number;
  settledAt: number;
};

export type LogEntry = {
  at: number;
  kind: string;
  npub?: string;
  round?: number;
  sats?: number;
  note?: string;
  /** Lightning proof for a movement of sats: the invoice that settled, and the preimage that proves it. */
  paymentHash?: string;
  preimage?: string;
  /** True when a practice circle booked the payment instead of moving sats. */
  simulated?: boolean;
};

/** What the caller knows about a payment when it books one: nothing, a record, or a settled invoice. */
export type PaymentProof = { paymentHash?: string; preimage?: string; simulated?: boolean };

export type Circle = {
  id: string;
  name: string;
  creatorNpub: string;
  demo: boolean;
  config: CircleConfig;
  phase: Phase;
  createdAt: number;
  startedAt: number;
  currentRound: number;
  members: Member[];
  /** round -> npubs that have paid it */
  paid: Record<string, string[]>;
  /** round -> sats actually collected (paid plus collateral coverage) */
  collected: Record<string, number>;
  topBidder: Record<string, string | null>;
  topDiscount: Record<string, number>;
  results: RoundResult[];
  /** round -> unix seconds the round closes */
  deadlines: Record<string, number>;
  /** payment_hash -> the contribution invoice it was issued for */
  invoices: Record<string, { npub: string; round: number; amountSats: number; createdAt: number }>;
  log: LogEntry[];
};

export type CircleErrorCode =
  | 'BadConfig'
  | 'WrongPhase'
  | 'JoinClosed'
  | 'Full'
  | 'AlreadyMember'
  | 'NotMember'
  | 'AlreadyPaid'
  | 'NotEligible'
  | 'MustContributeFirst'
  | 'BiddingClosed'
  | 'DiscountTooHigh'
  | 'BidTooLow'
  | 'RoundStillOpen'
  | 'NotCancellable'
  | 'NothingToWithdraw'
  | 'BadAmount';

export class CircleError extends Error {
  code: CircleErrorCode;

  constructor(code: CircleErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'CircleError';
    this.code = code;
  }
}

// ------------------------------------------------------------------------------------------------- config

function isWholeSats(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/** Rejects any configuration the rules could not honour. Throws `BadConfig` with the first problem. */
export function validateConfig(c: CircleConfig): void {
  if (!isWholeSats(c.contributionSats) || c.contributionSats <= 0) {
    throw new CircleError('BadConfig', 'each round must be a whole number of satoshis above zero');
  }
  if (!Number.isInteger(c.size) || c.size < MIN_SIZE || c.size > MAX_SIZE) {
    throw new CircleError('BadConfig', `a circle needs between ${MIN_SIZE} and ${MAX_SIZE} members`);
  }
  if (!Number.isInteger(c.roundSeconds) || c.roundSeconds < 60) {
    throw new CircleError('BadConfig', 'a round must last at least 60 seconds');
  }
  if (!Number.isInteger(c.joinWindowSeconds) || c.joinWindowSeconds < 60) {
    throw new CircleError('BadConfig', 'the join window must last at least 60 seconds');
  }
  if (!isWholeSats(c.collateralSats)) {
    throw new CircleError('BadConfig', 'collateral must be a whole number of satoshis');
  }
  if (!Number.isInteger(c.bondBps) || c.bondBps < 0 || c.bondBps > MAX_BOND_BPS) {
    throw new CircleError('BadConfig', `the winner's bond must be between 0% and ${MAX_BOND_BPS / 100}%`);
  }
  if (!Number.isInteger(c.maxDiscountBps) || c.maxDiscountBps < 0 || c.maxDiscountBps > MAX_DISCOUNT_BPS) {
    throw new CircleError('BadConfig', `the auction cap must be between 0% and ${MAX_DISCOUNT_BPS / 100}%`);
  }
  if (c.mode === 'fixed' && c.maxDiscountBps !== 0) {
    throw new CircleError('BadConfig', 'a fixed-order circle has no auction cap');
  }
  if (c.mode !== 'fixed' && c.mode !== 'auction') {
    throw new CircleError('BadConfig', 'unknown mode');
  }
  // Every satoshi of lifetime payouts has to fit in a JS number without losing precision.
  const lifetime = c.size * c.size * c.contributionSats + c.size * c.collateralSats;
  if (lifetime > Number.MAX_SAFE_INTEGER / 2) {
    throw new CircleError('BadConfig', 'that circle is too large to track exactly');
  }
}

export function createCircle(input: {
  id: string;
  name: string;
  creatorNpub: string;
  config: CircleConfig;
  now: number;
  demo?: boolean;
}): Circle {
  validateConfig(input.config);
  const name = input.name.trim();
  if (!name || name.length > 60) {
    throw new CircleError('BadConfig', 'give the circle a name of 1 to 60 characters');
  }
  if (!input.creatorNpub) throw new CircleError('BadConfig', 'a circle needs a creator');
  return {
    id: input.id,
    name,
    creatorNpub: input.creatorNpub,
    demo: input.demo === true,
    config: { ...input.config },
    phase: 'forming',
    createdAt: input.now,
    startedAt: 0,
    currentRound: 0,
    members: [],
    paid: {},
    collected: {},
    topBidder: {},
    topDiscount: {},
    results: [],
    deadlines: {},
    invoices: {},
    log: [{ at: input.now, kind: 'created', npub: input.creatorNpub, note: name }],
  };
}

// -------------------------------------------------------------------------------------------------- views

export function potSizeSats(circle: Circle): number {
  return circle.config.contributionSats * circle.config.size;
}

export function maxDiscountSats(circle: Circle): number {
  return Math.floor((potSizeSats(circle) * circle.config.maxDiscountBps) / 10_000);
}

export function roundDeadline(circle: Circle, round: number): number {
  const known = circle.deadlines[String(round)];
  if (typeof known === 'number') return known;
  return circle.startedAt + round * circle.config.roundSeconds;
}

export function joinDeadline(circle: Circle): number {
  return circle.createdAt + circle.config.joinWindowSeconds;
}

export function findMember(circle: Circle, npub: string): Member | undefined {
  return circle.members.find((m) => m.npub === npub);
}

function member(circle: Circle, npub: string): Member {
  const m = findMember(circle, npub);
  if (!m) throw new CircleError('NotMember', 'this Nostr identity is not a member of the circle');
  return m;
}

export function hasPaid(circle: Circle, round: number, npub: string): boolean {
  return (circle.paid[String(round)] ?? []).includes(npub);
}

function allActivePaid(circle: Circle, round: number): boolean {
  return circle.members.every((m) => m.defaulted || hasPaid(circle, round, m.npub));
}

/** What the coordinator owes a member right now: their credits, plus bond and collateral once the circle ends. */
export function owedSats(circle: Circle, npub: string): number {
  const m = member(circle, npub);
  const ended = circle.phase === 'completed' || circle.phase === 'cancelled';
  return m.claimable + (ended ? m.bond + m.collateralLeft : 0);
}

// -------------------------------------------------------------------------------------------------- forming

export function join(circle: Circle, npub: string, now: number): void {
  if (circle.phase !== 'forming') throw new CircleError('WrongPhase', 'this circle is not open for joining');
  if (now > joinDeadline(circle)) throw new CircleError('JoinClosed', 'the join window has closed');
  if (findMember(circle, npub)) throw new CircleError('AlreadyMember', 'you are already a member');
  if (circle.members.length >= circle.config.size) throw new CircleError('Full', 'every seat is taken');

  circle.members.push({
    npub,
    joinedAt: now,
    won: false,
    defaulted: false,
    withdrawn: false,
    wonRound: 0,
    onTime: 0,
    missed: 0,
    collateralLeft: circle.config.collateralSats,
    bond: 0,
    contributed: 0,
    received: 0,
    claimable: 0,
    withdrawnSats: 0,
  });
  circle.log.push({ at: now, kind: 'joined', npub, sats: circle.config.collateralSats });

  if (circle.members.length === circle.config.size) {
    circle.phase = 'active';
    circle.startedAt = now;
    circle.currentRound = 1;
    circle.deadlines['1'] = now + circle.config.roundSeconds;
    circle.log.push({ at: now, kind: 'started', round: 1 });
  }
}

export function cancel(circle: Circle, npub: string, now: number): void {
  if (circle.phase !== 'forming') throw new CircleError('WrongPhase', 'only a circle that has not started can be cancelled');
  const expired = now > joinDeadline(circle);
  if (!expired && npub !== circle.creatorNpub) {
    throw new CircleError('NotCancellable', 'only the creator can cancel before the join window ends');
  }
  circle.phase = 'cancelled';
  circle.log.push({ at: now, kind: 'cancelled', npub });
}

// --------------------------------------------------------------------------------------------------- rounds

/**
 * Record a member's contribution for the open round. The caller only gets here after the Lightning
 * invoice for that contribution has actually settled.
 */
export function contribute(circle: Circle, npub: string, now: number, proof: PaymentProof = {}): { onTime: boolean } {
  if (circle.phase !== 'active') throw new CircleError('WrongPhase', 'this circle is not running');
  const m = member(circle, npub);
  if (m.defaulted) throw new CircleError('NotEligible', 'this member has defaulted');
  const r = circle.currentRound;
  if (hasPaid(circle, r, npub)) throw new CircleError('AlreadyPaid', 'you have already paid this round');

  const onTime = now <= roundDeadline(circle, r);
  const amount = circle.config.contributionSats;
  const key = String(r);
  circle.paid[key] = [...(circle.paid[key] ?? []), npub];
  circle.collected[key] = (circle.collected[key] ?? 0) + amount;
  m.contributed += amount;
  if (onTime) m.onTime += 1;
  circle.log.push({ at: now, kind: 'contributed', npub, round: r, sats: amount, note: onTime ? 'on time' : 'late', ...proof });
  return { onTime };
}

export function bid(circle: Circle, npub: string, discountSats: number, now: number): void {
  if (circle.config.mode !== 'auction') throw new CircleError('NotEligible', 'this circle takes the pot in join order');
  if (circle.phase !== 'active') throw new CircleError('WrongPhase', 'this circle is not running');
  const r = circle.currentRound;
  if (now > roundDeadline(circle, r)) throw new CircleError('BiddingClosed', 'bidding for this round has closed');
  const m = member(circle, npub);
  if (m.won || m.defaulted) throw new CircleError('NotEligible', 'only members who have not taken a pot can bid');
  if (!hasPaid(circle, r, npub)) throw new CircleError('MustContributeFirst', 'pay this round before bidding');
  if (!isWholeSats(discountSats) || discountSats <= 0) {
    throw new CircleError('BadAmount', 'a bid must be a whole number of satoshis above zero');
  }
  const collected = circle.collected[String(r)] ?? 0;
  if (discountSats > maxDiscountSats(circle) || discountSats > collected) {
    throw new CircleError('DiscountTooHigh', 'that discount is above what this circle allows');
  }
  const current = circle.topDiscount[String(r)] ?? 0;
  if (circle.topBidder[String(r)] && discountSats <= current) {
    throw new CircleError('BidTooLow', 'someone already offered that much or more');
  }
  circle.topBidder[String(r)] = npub;
  circle.topDiscount[String(r)] = discountSats;
  circle.log.push({ at: now, kind: 'bid', npub, round: r, sats: discountSats });
}

function coverMissed(circle: Circle, round: number): void {
  const amount = circle.config.contributionSats;
  for (const m of circle.members) {
    if (hasPaid(circle, round, m.npub) || m.defaulted) continue;

    const fromCollateral = Math.min(m.collateralLeft, amount);
    m.collateralLeft -= fromCollateral;
    const rest = amount - fromCollateral;
    const fromBond = Math.min(m.bond, rest);
    m.bond -= fromBond;
    const covered = fromCollateral + fromBond;

    m.missed += 1;
    const key = String(round);
    circle.collected[key] = (circle.collected[key] ?? 0) + covered;
    circle.paid[key] = [...(circle.paid[key] ?? []), m.npub];
    if (covered < amount) m.defaulted = true;
    circle.log.push({
      at: 0,
      kind: 'missed',
      npub: m.npub,
      round,
      sats: covered,
      note: m.defaulted ? 'defaulted' : 'covered from collateral',
    });
  }
}

function nextInLine(circle: Circle): Member | null {
  for (const m of circle.members) {
    if (!m.won && !m.defaulted) return m;
  }
  return null;
}

/**
 * Split `amount` equally among members in good standing except `exclude`, crediting their claimable
 * balance. Returns the remainder that could not be divided; with an `exclude` the caller adds it to
 * that member's payout, so no satoshi is stranded.
 */
function splitAmongGood(circle: Circle, round: number, amount: number, exclude: string | null, now: number): number {
  let eligible = circle.members.filter((m) => m.npub !== exclude && !m.defaulted);
  let everyone = false;
  if (eligible.length === 0) {
    eligible = circle.members.filter((m) => m.npub !== exclude);
    everyone = true;
  }
  if (eligible.length === 0) return amount;

  const share = Math.floor(amount / eligible.length);
  let dust = amount - share * eligible.length;
  for (const m of eligible) {
    let pay = share;
    if (exclude === null && dust > 0) {
      pay += dust;
      dust = 0;
    }
    if (pay === 0) continue;
    m.received += pay;
    m.claimable += pay;
    circle.log.push({ at: now, kind: everyone ? 'share' : 'dividend', npub: m.npub, round, sats: pay });
  }
  return dust;
}

export type SettleOutcome = {
  result: RoundResult;
  /** every member the coordinator currently owes sats to */
  obligations: { npub: string; sats: number }[];
};

/**
 * Close the current round. Anyone can call it once the deadline has passed; a fixed-order circle can
 * also be closed the moment every active member has paid.
 */
export function settleRound(circle: Circle, now: number): SettleOutcome {
  if (circle.phase !== 'active') throw new CircleError('WrongPhase', 'this circle is not running');
  const round = circle.currentRound;
  const open = now <= roundDeadline(circle, round);
  if (open && !(circle.config.mode === 'fixed' && allActivePaid(circle, round))) {
    throw new CircleError('RoundStillOpen', 'the round is still open');
  }

  coverMissed(circle, round);

  let winner: Member | null = null;
  if (circle.config.mode === 'auction') {
    const top = circle.topBidder[String(round)] ?? null;
    if (top) {
      const m = findMember(circle, top);
      // A top bidder who defaulted while this round was covered loses the bid.
      if (m && !m.defaulted) winner = m;
    }
  }
  let discount = winner ? (circle.topDiscount[String(round)] ?? 0) : 0;
  if (!winner) winner = nextInLine(circle);

  const pot = circle.collected[String(round)] ?? 0;
  let result: RoundResult;

  if (!winner) {
    // Every remaining member defaulted: share the pot among members still in good standing.
    splitAmongGood(circle, round, pot, null, now);
    result = { round, winner: null, pot, discount: 0, payout: 0, bondHeld: 0, settledAt: now };
    circle.log.push({ at: now, kind: 'settled', round, sats: pot, note: 'no winner left; pot shared' });
  } else {
    if (discount > pot) discount = pot;
    const gross = pot - discount;
    const stillOwed = (circle.config.size - round) * circle.config.contributionSats;
    const bondHeld = Math.min(Math.floor((gross * circle.config.bondBps) / 10_000), stillOwed);

    winner.won = true;
    winner.wonRound = round;
    winner.bond += bondHeld;

    const dust = discount > 0 ? splitAmongGood(circle, round, discount, winner.npub, now) : 0;
    const payout = gross - bondHeld + dust;
    winner.received += payout;
    winner.claimable += payout;

    result = { round, winner: winner.npub, pot, discount, payout, bondHeld, settledAt: now };
    circle.log.push({ at: now, kind: 'settled', npub: winner.npub, round, sats: payout });
  }

  circle.results.push(result);

  if (round === circle.config.size) {
    circle.phase = 'completed';
    circle.log.push({ at: now, kind: 'completed' });
  } else {
    circle.currentRound = round + 1;
    // Keep rounds in step with the start, but never give the next round less than a full window.
    const scheduled = circle.startedAt + (round + 1) * circle.config.roundSeconds;
    const fullWindow = now + circle.config.roundSeconds;
    circle.deadlines[String(round + 1)] = Math.max(scheduled, fullWindow);
  }

  const obligations = circle.members
    .map((m) => ({ npub: m.npub, sats: m.claimable }))
    .filter((o) => o.sats > 0);
  return { result, obligations };
}

/**
 * Pay a member what the circle owes them. `amountSats` must equal `owedSats` exactly: the caller
 * checks it against the amount encoded in the member's Lightning invoice before calling.
 */
export function takePayout(circle: Circle, npub: string, amountSats: number, now: number, proof: PaymentProof = {}): void {
  const m = member(circle, npub);
  const owed = owedSats(circle, npub);
  if (owed === 0) throw new CircleError('NothingToWithdraw', 'nothing is owed to this member');
  if (!isWholeSats(amountSats) || amountSats !== owed) {
    throw new CircleError('BadAmount', `this member is owed exactly ${owed} sats`);
  }
  // Only clear what was actually paid. Mid-circle the bond and collateral are still protecting the
  // other members, so taking a pot must not touch them: that would silently strip a winner's cover.
  const ended = circle.phase === 'completed' || circle.phase === 'cancelled';
  m.claimable = 0;
  if (ended) {
    m.bond = 0;
    m.collateralLeft = 0;
  }
  m.withdrawn = ended;
  m.withdrawnSats += amountSats;
  circle.log.push({ at: now, kind: 'payout', npub, sats: amountSats, ...proof });
}

// ---------------------------------------------------------------------------------------- invariants

/**
 * The sats the circle must hold: everything members put in, minus everything paid out. Used by the
 * tests and exposed to the UI so the demo can prove no satoshi was created or stranded.
 */
export function balanceSheet(circle: Circle): { inSats: number; outSats: number; owedSats: number; strandedSats: number } {
  // Collateral arrived when each member joined; contributions arrived as they paid.
  const collateralIn = circle.members.length * circle.config.collateralSats;
  const contributedIn = circle.members.reduce((sum, m) => sum + m.contributed, 0);
  const inSats = collateralIn + contributedIn;
  const outSats = circle.members.reduce((sum, m) => sum + m.withdrawnSats, 0);
  const owedSats = circle.members.reduce((sum, m) => sum + m.claimable + m.bond + m.collateralLeft, 0);
  return { inSats, outSats, owedSats, strandedSats: inSats - outSats - owedSats };
}
