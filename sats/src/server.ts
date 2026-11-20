/**
 * The coordinator's HTTP surface.
 *
 * Every mutating member action is authenticated by a signed Nostr event (or, inside a practice
 * circle only, by a throwaway demo identity). Sats only move when the wallet says an invoice settled,
 * and a payout is only paid if the member's invoice asks for exactly what the circle owes them.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import {
  CircleError,
  bid as placeBid,
  cancel as cancelCircle,
  contribute as recordContribution,
  createCircle,
  findMember,
  hasPaid,
  join as joinCircle,
  maxDiscountSats,
  owedSats,
  potSizeSats,
  roundDeadline,
  settleRound,
  takePayout,
} from './circle.ts';
import type { Circle, CircleConfig, Mode } from './circle.ts';
import { AuthError, verifyAuth } from './auth.ts';
import { InvoiceError, decodeInvoiceAmountSats } from './bolt11.ts';
import { NwcClient, NwcError } from './nwc.ts';
import { createIdentity, isValidNpub, npubFromPubkey, pubkeyFromNpub, publishCircle } from './nostr.ts';
import type { Identity } from './nostr.ts';
import { Store } from './store.ts';
import { statsFor, score, explain } from './reputation.ts';
import { LANGS, briefing, flagRound, isLang, memberNote, reminder } from './ai.ts';
import { dataDir, demoMode, loadEnv, nwcConnection, nwcError, port, publicUrl, relays } from './env.ts';

loadEnv();

const now = () => Math.floor(Date.now() / 1000);
const store = new Store(dataDir());
const startedAt = now();

// Load before touching the identity: the coordinator's key lives in the file we are about to read.
await store.load();
const identity: Identity = store.identity();

/** Throwaway identities for browsers without a Nostr extension. Practice circles only. */
const demoIdentities = new Map<string, Identity>();
/** Bot members that live on the server, per circle. Their sats are simulated, and labelled so. */
const bots = new Map<string, Map<string, Identity>>();

let wallet: NwcClient | null = null;
function walletClient(): NwcClient {
  const conn = nwcConnection();
  if (!conn) throw new NwcError('NotConfigured', nwcError() ?? 'no wallet connected yet');
  if (!wallet) wallet = new NwcClient(conn);
  return wallet;
}

// ------------------------------------------------------------------------------------------ helpers

class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 32 * 1024) throw new HttpError(413, 'TooLarge', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'BadBody', 'expected a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'BadBody', 'the request body is not valid JSON');
  }
}

const hits = new Map<string, { count: number; reset: number }>();
function rateLimit(req: IncomingMessage): void {
  const ip = req.socket.remoteAddress ?? 'local';
  const t = now();
  const entry = hits.get(ip);
  if (!entry || t > entry.reset) {
    hits.set(ip, { count: 1, reset: t + 60 });
    return;
  }
  entry.count += 1;
  if (entry.count > 240) throw new HttpError(429, 'RateLimited', 'too many requests; wait a minute');
}

function getCircle(id: string): Circle {
  const circle = store.get(id);
  if (!circle) throw new HttpError(404, 'NotFound', 'no such circle');
  return circle;
}

type Actor = { npub: string; payload: Record<string, unknown>; bot: boolean };

/**
 * Resolve who is acting. A signed event is the real path; a demo identity is accepted only inside a
 * practice circle, because the server holds that key and it protects nothing.
 */
function actor(circle: Circle, action: string, input: Record<string, unknown>): Actor {
  if (input.event) {
    const verified = verifyAuth(input.event, { action, circleId: circle.id, now: now() });
    return { npub: npubFromPubkey(verified.pubkey), payload: verified.payload, bot: false };
  }
  const demoId = typeof input.demoId === 'string' ? input.demoId : '';
  if (demoId) {
    if (!demoMode()) throw new HttpError(403, 'DemoOff', 'demo identities are switched off');
    if (!circle.demo) throw new HttpError(403, 'DemoOnly', 'a demo identity can only act in a practice circle');
    const demo = demoIdentities.get(demoId);
    if (!demo) throw new HttpError(401, 'UnknownDemo', 'that demo identity has expired; reload the page');
    const payload =
      input.payload && typeof input.payload === 'object' ? (input.payload as Record<string, unknown>) : {};
    return { npub: demo.npub, payload, bot: false };
  }
  throw new HttpError(401, 'Unauthorized', 'sign this action with your Nostr key');
}

/** Recompute a circle's derived values, then persist and return it. */
async function save(circle: Circle): Promise<Circle> {
  await store.put(circle);
  return view(circle);
}

function view(circle: Circle) {
  return {
    ...circle,
    potSats: potSizeSats(circle),
    maxDiscountSats: maxDiscountSats(circle),
    joinDeadline: circle.createdAt + circle.config.joinWindowSeconds,
    roundDeadline: circle.phase === 'active' ? roundDeadline(circle, circle.currentRound) : 0,
    balance: {
      inSats: circle.members.reduce((s, m) => s + m.contributed, 0) + circle.members.length * circle.config.collateralSats,
      owedSats: circle.members.reduce((s, m) => s + m.claimable + m.bond + m.collateralLeft, 0),
      paidOutSats: circle.members.reduce((s, m) => s + m.withdrawnSats, 0),
    },
  };
}

async function announce(circle: Circle): Promise<{ eventId: string; accepted: string[] }> {
  try {
    const r = await publishCircle(identity, relays(), circle);
    return { eventId: r.eventId, accepted: r.accepted };
  } catch {
    return { eventId: '', accepted: [] };
  }
}

function parseConfig(input: unknown, demo: boolean): CircleConfig {
  const raw = (input ?? {}) as Record<string, unknown>;
  const mode: Mode = raw.mode === 'auction' ? 'auction' : 'fixed';
  const num = (value: unknown, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : fallback;
  };
  return {
    contributionSats: num(raw.contributionSats, demo ? 21 : 1000),
    size: num(raw.size, 4),
    roundSeconds: num(raw.roundSeconds, 60),
    joinWindowSeconds: num(raw.joinWindowSeconds, 3600),
    collateralSats: num(raw.collateralSats, 0),
    bondBps: num(raw.bondBps, mode === 'auction' ? 2000 : 0),
    maxDiscountBps: mode === 'auction' ? num(raw.maxDiscountBps, 1000) : 0,
    mode,
  };
}

// -------------------------------------------------------------------------------------------- routes

async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', publicUrl());
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // --- static
  if (!path.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method', 'only GET is allowed');
    const rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    if (rel.includes('..')) throw new HttpError(400, 'BadPath', 'bad path');

    // Platforms in front of the app rewrite `/` to `/index` and drop extensions, so a request for a
    // path without one is tried as a directory index and then as `.html` before it is a 404. Without
    // this the app serves every file but its own front page behind such a proxy.
    const root = join(import.meta.dirname, '..', 'public');
    const candidates = extname(rel) ? [rel] : [`${rel}/index.html`, `${rel}.html`];
    let file = '';
    let data: Buffer | null = null;
    for (const candidate of candidates) {
      const full = normalize(join(root, candidate));
      try {
        data = await readFile(full);
        file = full;
        break;
      } catch {
        /* try the next candidate */
      }
    }
    if (!data) throw new HttpError(404, 'NotFound', 'not found');

    const type =
      { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' }[
        extname(file)
      ] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(method === 'HEAD' ? undefined : data);
    return true;
  }

  // --- health
  if (path === '/api/health' && method === 'GET') {
    send(res, 200, {
      ok: true,
      uptimeSeconds: now() - startedAt,
      nwc: nwcConnection() !== null,
      nwcError: nwcError(),
      ai: Boolean(process.env.OPENAI_API_KEY?.trim()),
      demo: demoMode(),
      relays: relays(),
      coordinatorNpub: identity.npub,
      publicUrl: publicUrl(),
      langs: LANGS,
    });
    return true;
  }

  // --- demo identity
  if (path === '/api/demo/identity' && method === 'POST') {
    if (!demoMode()) throw new HttpError(403, 'DemoOff', 'demo identities are switched off');
    const fresh = createIdentity();
    const demoId = randomBytes(16).toString('hex');
    demoIdentities.set(demoId, fresh);
    send(res, 200, { demoId, npub: fresh.npub, pubkey: fresh.pubkey });
    return true;
  }

  // --- list
  if (path === '/api/circles' && method === 'GET') {
    send(res, 200, { circles: store.list().map(view) });
    return true;
  }

  // --- create
  if (path === '/api/circles' && method === 'POST') {
    rateLimit(req);
    const input = await body(req);
    const demo = input.demo === true;
    if (demo && !demoMode()) throw new HttpError(403, 'DemoOff', 'practice circles are switched off');
    if (!demo && !input.event) throw new HttpError(401, 'Unauthorized', 'sign this action with your Nostr key');

    // A signed event always wins, practice circle or not: the creator must be the same key that
    // will join and pay, or the visitor ends up in their own circle as a stranger. The throwaway
    // demo identity is only the fallback for a visitor with no key at all.
    let npub: string;
    if (demo && !input.event) {
      const demoId = typeof input.demoId === 'string' ? input.demoId : '';
      const demoIdentity = demoIdentities.get(demoId);
      if (!demoIdentity) throw new HttpError(401, 'UnknownDemo', 'reload the page to get a practice identity');
      npub = demoIdentity.npub;
    } else {
      npub = npubFromPubkey(verifyAuth(input.event, { action: 'create', now: now() }).pubkey);
    }

    const config = parseConfig(input.config, demo);
    const circle = createCircle({
      id: randomBytes(6).toString('hex'),
      name: typeof input.name === 'string' ? input.name : 'Savings circle',
      creatorNpub: npub,
      config,
      now: now(),
      demo,
    });
    await store.put(circle);
    const published = await announce(circle);
    send(res, 201, { circle: view(circle), nostrEventId: published.eventId });
    return true;
  }

  const match = path.match(/^\/api\/circles\/([a-zA-Z0-9]+)(\/[a-z/]+)?$/);
  if (match) {
    const circle = getCircle(match[1]);
    const sub = match[2] ?? '';

    if (!sub && method === 'GET') {
      send(res, 200, { circle: view(circle) });
      return true;
    }

    if (sub === '/flags' && method === 'GET') {
      send(res, 200, { flags: flagRound(circle, now()) });
      return true;
    }

    if (sub === '/briefing' && method === 'GET') {
      send(res, 200, await briefing(circle, now()));
      return true;
    }

    if (sub === '/join' && method === 'POST') {
      rateLimit(req);
      const input = await body(req);
      const who = actor(circle, 'join', input);
      joinCircle(circle, who.npub, now());
      send(res, 200, { circle: await save(circle) });
      return true;
    }

    if (sub === '/cancel' && method === 'POST') {
      const input = await body(req);
      const who = actor(circle, 'cancel', input);
      cancelCircle(circle, who.npub, now());
      send(res, 200, { circle: await save(circle) });
      return true;
    }

    if (sub === '/contribute' && method === 'POST') {
      rateLimit(req);
      const input = await body(req);
      const who = actor(circle, 'contribute', input);
      if (circle.phase !== 'active') throw new CircleError('WrongPhase', 'this circle is not running');
      if (!findMember(circle, who.npub)) throw new CircleError('NotMember', 'join the circle first');
      if (hasPaid(circle, circle.currentRound, who.npub)) {
        throw new CircleError('AlreadyPaid', 'you have already paid this round');
      }

      // A practice circle may record the payment instead of invoicing it: either because no wallet is
      // connected, or because the visitor asked for it (`record: true`) and has no sats to spend. A real
      // circle never takes this path, and the response is always marked `simulated`.
      const record = who.payload.record === true || input.record === true;
      if (record && !circle.demo) {
        throw new HttpError(400, 'BadBody', 'only a practice circle can record a payment without moving sats');
      }
      if (record || !nwcConnection()) {
        if (!circle.demo) throw new NwcError('NotConfigured', nwcError() ?? 'no wallet connected yet');
        const { onTime } = recordContribution(circle, who.npub, now(), { simulated: true });
        send(res, 200, { simulated: true, onTime, circle: await save(circle) });
        return true;
      }

      const client = walletClient();
      const { invoice, payment_hash } = await client.makeInvoice(
        circle.config.contributionSats,
        `Zappot · ${circle.name} · round ${circle.currentRound}`,
      );
      circle.invoices[payment_hash] = {
        npub: who.npub,
        round: circle.currentRound,
        amountSats: circle.config.contributionSats,
        createdAt: now(),
      };
      await store.put(circle);
      send(res, 200, { invoice, paymentHash: payment_hash, amountSats: circle.config.contributionSats });
      return true;
    }

    if (sub === '/contribute/confirm' && method === 'POST') {
      const input = await body(req);
      const who = actor(circle, 'contribute', input);
      const paymentHash = String(who.payload.paymentHash ?? input.paymentHash ?? '');
      const pending = circle.invoices[paymentHash];
      if (!pending || pending.npub !== who.npub) {
        throw new HttpError(404, 'NotFound', 'no invoice of yours matches that payment');
      }
      const client = walletClient();
      const state = await client.lookupInvoice({ payment_hash: paymentHash });
      if (!NwcClient.isSettled(state)) {
        throw new HttpError(409, 'NotSettled', 'the wallet has not seen that payment yet');
      }
      const { onTime } = recordContribution(circle, who.npub, now(), { paymentHash });
      delete circle.invoices[paymentHash];
      send(res, 200, { circle: await save(circle), onTime });
      return true;
    }

    if (sub === '/bid' && method === 'POST') {
      const input = await body(req);
      const who = actor(circle, 'bid', input);
      const amount = Number(who.payload.discountSats ?? input.discountSats);
      placeBid(circle, who.npub, Math.floor(amount), now());
      send(res, 200, { circle: await save(circle) });
      return true;
    }

    if (sub === '/settle' && method === 'POST') {
      const input = await body(req);
      const who = actor(circle, 'settle', input);
      if (!findMember(circle, who.npub) && who.npub !== circle.creatorNpub) {
        throw new HttpError(403, 'Forbidden', 'only a member can close a round');
      }
      const outcome = settleRound(circle, now());
      const published = await announce(circle);
      send(res, 200, { circle: await save(circle), result: outcome.result, nostrEventId: published.eventId });
      return true;
    }

    if (sub === '/payout' && method === 'POST') {
      rateLimit(req);
      const input = await body(req);
      const who = actor(circle, 'payout', input);
      const m = findMember(circle, who.npub);
      if (!m) throw new CircleError('NotMember', 'this Nostr identity is not a member of the circle');
      const owed = owedSats(circle, who.npub);
      if (owed === 0) throw new CircleError('NothingToWithdraw', 'nothing is owed to you right now');

      // Same rule as a contribution: a practice circle can book the payout when there is no wallet, or
      // when the visitor explicitly asks to record it instead of receiving sats.
      const recordPayout = who.payload.record === true || input.record === true;
      if (recordPayout && !circle.demo) {
        throw new HttpError(400, 'BadBody', 'only a practice circle can record a payout without moving sats');
      }
      if (recordPayout || !nwcConnection()) {
        if (!circle.demo) throw new NwcError('NotConfigured', nwcError() ?? 'no wallet connected yet');
        takePayout(circle, who.npub, owed, now(), { simulated: true });
        send(res, 200, { simulated: true, paidSats: owed, circle: await save(circle) });
        return true;
      }

      // A practice circle needs no pasted invoice: the wallet issues one for exactly what is owed and
      // pays it, so the claim is a single click. A real circle still needs the member's own invoice —
      // the coordinator paying its own wallet would not pay them.
      const pasted = String(who.payload.invoice ?? input.invoice ?? '').trim();
      const client = walletClient();
      let invoice = pasted;
      let selfInvoiced = false;
      let paymentHash: string | undefined;
      if (!invoice) {
        if (!circle.demo) throw new HttpError(400, 'BadBody', 'send a Lightning invoice for the amount you are owed');
        const minted = await client.makeInvoice(owed, `Zappot · ${circle.name} · payout`);
        invoice = minted.invoice;
        paymentHash = minted.payment_hash;
        selfInvoiced = true;
      }
      let asks: number | null;
      try {
        asks = decodeInvoiceAmountSats(invoice);
      } catch (e) {
        throw new HttpError(400, 'BadInvoice', (e as InvoiceError).message);
      }
      // The wallet pays whatever the invoice says: refuse anything that is not exactly what is owed.
      if (asks !== owed) {
        throw new CircleError('BadAmount', `this member is owed exactly ${owed} sats, but the invoice asks for ${asks ?? 'no amount'}`);
      }

      const paid = await client.payInvoice(invoice);
      takePayout(circle, who.npub, owed, now(), { paymentHash, preimage: paid.preimage });
      send(res, 200, {
        circle: await save(circle),
        paidSats: owed,
        paymentHash,
        preimage: paid.preimage,
        ...(selfInvoiced ? { selfInvoiced } : {}),
      });
      return true;
    }

    if (sub === '/reminder' && method === 'POST') {
      rateLimit(req);
      const input = await body(req);
      const who = actor(circle, 'reminder', input);
      const lang = isLang(who.payload.lang ?? input.lang) ? ((who.payload.lang ?? input.lang) as 'fr' | 'en' | 'wo') : 'en';
      send(res, 200, await reminder(circle, who.npub, lang, now()));
      return true;
    }

    // --- practice helpers: server-side bots with simulated sats, clearly labelled in the log
    if (sub === '/demo' && method === 'POST') {
      if (!circle.demo || !demoMode()) throw new HttpError(403, 'DemoOnly', 'this is only for practice circles');
      const input = await body(req);
      let roster = bots.get(circle.id);
      if (!roster) {
        roster = new Map();
        bots.set(circle.id, roster);
      }
      const makeBots = (n: number) => {
        for (let i = 0; i < n && circle.members.length < circle.config.size; i += 1) {
          const bot = createIdentity();
          roster!.set(bot.npub, bot);
          joinCircle(circle, bot.npub, now());
          circle.log.push({ at: now(), kind: 'bot', npub: bot.npub, note: 'simulated member' });
        }
      };

      if (typeof input.join === 'number') makeBots(Math.max(0, Math.min(19, Math.floor(input.join))));
      if (input.pay === true && circle.phase === 'active') {
        for (const npub of roster.keys()) {
          const m = findMember(circle, npub);
          if (!m || m.defaulted || hasPaid(circle, circle.currentRound, npub)) continue;
          recordContribution(circle, npub, now(), { simulated: true });
          circle.log.push({ at: now(), kind: 'bot', npub, round: circle.currentRound, note: 'paid (simulated)' });
        }
      }
      if (input.bid === true && circle.phase === 'active' && circle.config.mode === 'auction') {
        const candidates = [...roster.keys()].filter((npub) => {
          const m = findMember(circle, npub);
          return m && !m.won && !m.defaulted && hasPaid(circle, circle.currentRound, npub);
        });
        const target = candidates[0];
        if (target) {
          const amount = Math.max(1, Math.floor(maxDiscountSats(circle) * 0.4));
          try {
            placeBid(circle, target, amount, now());
            circle.log.push({ at: now(), kind: 'bot', npub: target, round: circle.currentRound, sats: amount, note: 'bid (simulated)' });
          } catch {
            /* the bot's bid was not competitive; nothing to do */
          }
        }
      }
      send(res, 200, { circle: await save(circle) });
      return true;
    }
  }

  // --- reputation
  const rep = path.match(/^\/api\/reputation\/([a-zA-Z0-9]+)$/);
  if (rep && method === 'GET') {
    let npub: string;
    try {
      npub = isValidNpub(rep[1]) ? rep[1] : pubkeyFromNpub(rep[1]);
    } catch {
      throw new HttpError(400, 'BadNpub', 'expected an npub');
    }
    const stats = statsFor(store.list(), npub);
    send(res, 200, { npub, stats, score: score(stats), notes: explain(stats), ...(await memberNote(npub, stats)) });
    return true;
  }

  throw new HttpError(404, 'NotFound', 'not found');
}

function describeError(e: unknown): { status: number; code: string; message: string } {
  if (e instanceof HttpError) return { status: e.status, code: e.code, message: e.message };
  if (e instanceof CircleError) return { status: 400, code: e.code, message: e.message };
  if (e instanceof AuthError) return { status: 401, code: 'Unauthorized', message: e.message };
  if (e instanceof InvoiceError) return { status: 400, code: 'BadInvoice', message: e.message };
  if (e instanceof NwcError) {
    const status = e.code === 'NotConfigured' ? 503 : 502;
    return { status, code: e.code, message: e.message };
  }
  return { status: 500, code: 'Internal', message: 'something went wrong on the coordinator' };
}

const server = createServer((req, res) => {
  void handle(req, res)
    .catch((e: unknown) => {
      const { status, code, message } = describeError(e);
      // Log the shape of the failure, never the request body: it can carry invoices and keys.
      if (status >= 500) console.error(`[${code}] ${(e as Error)?.name ?? 'Error'}: ${message}`);
      send(res, status, { error: code, message });
    })
    .catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'Internal', message: 'could not answer' });
    });
});

server.listen(port(), () => {
  console.log(`Zappot Sats listening on ${publicUrl()}`);
  console.log(`coordinator npub ${identity.npub}`);
  console.log(`wallet ${nwcConnection() ? 'connected via NWC' : 'not connected — ' + (nwcError() ?? 'set NWC_URI')}`);
  console.log(`AI coordinator ${process.env.OPENAI_API_KEY?.trim() ? 'on' : 'off (templates and rules only)'}`);
});
