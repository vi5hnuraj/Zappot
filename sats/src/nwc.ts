/**
 * Nostr Wallet Connect (NIP-47) client.
 *
 * The circle never holds a Lightning seed. It holds an NWC connection string that a member (or the
 * group's treasurer) granted from their own wallet, and it can only do what that grant allows:
 * `make_invoice`, `lookup_invoice` and `pay_invoice`. Every request is a signed, encrypted Nostr
 * event, so the wallet is reachable through relays without either side exposing an IP or a port.
 */

import { finalizeEvent, getPublicKey, nip04 } from 'nostr-tools';
import { SimplePool } from 'nostr-tools/pool';

export type NwcConnection = {
  walletPubkey: string;
  relays: string[];
  secretKey: Uint8Array;
  lud16?: string;
};

export type NwcErrorCode =
  | 'InvalidUri'
  | 'NoRelay'
  | 'Timeout'
  | 'Rejected'
  | 'RateLimited'
  | 'NotFound'
  | 'Internal'
  | 'NotConfigured';

export class NwcError extends Error {
  code: NwcErrorCode;

  constructor(code: NwcErrorCode, message: string) {
    super(message);
    this.name = 'NwcError';
    this.code = code;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function parseNwcUri(uri: string): NwcConnection {
  const trimmed = (uri ?? '').trim();
  const prefix = 'nostr+walletconnect://';
  if (!trimmed.toLowerCase().startsWith(prefix)) {
    throw new NwcError('InvalidUri', 'a connection string starts with nostr+walletconnect://');
  }
  const rest = trimmed.slice(prefix.length);
  const [pubkeyPart, queryPart = ''] = rest.split('?');
  const walletPubkey = pubkeyPart.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(walletPubkey)) {
    throw new NwcError('InvalidUri', 'the connection string has no valid wallet public key');
  }

  const params = new URLSearchParams(queryPart);
  const relays: string[] = [];
  for (const raw of params.getAll('relay')) {
    for (const part of raw.split(',')) {
      const relay = part.trim();
      if (/^wss?:\/\/[^\s]+$/i.test(relay) && !relays.includes(relay)) relays.push(relay);
    }
  }
  if (relays.length === 0) throw new NwcError('InvalidUri', 'the connection string has no relay');

  const secretHex = (params.get('secret') ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(secretHex)) {
    throw new NwcError('InvalidUri', 'the connection string has no valid secret');
  }

  const lud16 = params.get('lud16')?.trim();
  return {
    walletPubkey,
    relays,
    secretKey: hexToBytes(secretHex),
    ...(lud16 ? { lud16 } : {}),
  };
}

export type MakeInvoiceResult = { invoice: string; payment_hash: string };
export type PayInvoiceResult = { preimage: string; fees_paid?: number };
export type LookupInvoiceResult = {
  invoice?: string;
  payment_hash?: string;
  amount?: number; // millisatoshis
  settled?: boolean;
  state?: string;
  preimage?: string;
};
export type BalanceResult = { balance: number }; // millisatoshis

export class NwcClient {
  conn: NwcConnection;
  pubkey: string;
  timeoutMs: number;
  pool: SimplePool;

  constructor(conn: NwcConnection, options: { timeoutMs?: number } = {}) {
    this.conn = conn;
    this.pool = new SimplePool();
    this.pubkey = getPublicKey(conn.secretKey);
    this.timeoutMs = options.timeoutMs ?? 45_000;
  }

  /** Send one NWC request and wait for the wallet's encrypted reply. */
  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const relays = this.conn.relays;
    if (relays.length === 0) throw new NwcError('NoRelay', 'no relay to reach the wallet on');

    let content: string;
    try {
      content = await nip04.encrypt(this.conn.secretKey, this.conn.walletPubkey, JSON.stringify({ method, params }));
    } catch {
      throw new NwcError('Internal', 'could not encrypt the wallet request');
    }

    const event = finalizeEvent(
      {
        kind: 23194,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', this.conn.walletPubkey]],
        content,
      },
      this.conn.secretKey,
    );

    const filter = { kinds: [23195], authors: [this.conn.walletPubkey], '#e': [event.id] };

    return await new Promise<unknown>((resolve, reject) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let poll: ReturnType<typeof setInterval> | undefined;

      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (poll) clearInterval(poll);
        try {
          sub.close();
        } catch {
          /* subscription may already be closed */
        }
        fn();
      };

      const handle = (reply: { content: string }) => {
        if (done) return;
        void (async () => {
          let body: { result?: unknown; error?: { code?: string; message?: string } | null };
          try {
            const plain = await nip04.decrypt(this.conn.secretKey, this.conn.walletPubkey, reply.content);
            body = JSON.parse(plain);
          } catch {
            return; // not for us, or not decryptable: keep waiting
          }
          finish(() => {
            if (body.error) {
              const code = String(body.error.code ?? '');
              const message = String(body.error.message ?? 'the wallet refused the request');
              reject(new NwcError(mapErrorCode(code), message));
            } else {
              resolve(body.result);
            }
          });
        })();
      };

      const sub = this.pool.subscribeMany(relays, [filter], { onevent: handle });

      timer = setTimeout(() => {
        finish(() => reject(new NwcError('Timeout', 'the wallet did not answer in time')));
      }, this.timeoutMs);

      // Some wallets answer before our live subscription is registered on the relay, so the reply
      // exists but never reaches onevent. Replay the stored reply as well, on a short poll.
      poll = setInterval(() => {
        if (done) return;
        void this.pool
          .querySync(relays, filter, { maxWait: 2500 })
          .then((events) => events.forEach((e) => handle(e)))
          .catch(() => {
            /* a transient relay error: the live subscription or the next poll may still win */
          });
      }, 1200);

      void Promise.allSettled(this.pool.publish(relays, event)).then((results) => {
        if (results.length > 0 && results.every((r) => r.status === 'rejected')) {
          finish(() => reject(new NwcError('NoRelay', 'no relay accepted the request')));
        }
      });
    });
  }

  /** Ask the wallet to issue an invoice for a member's contribution. */
  async makeInvoice(amountSats: number, description: string): Promise<MakeInvoiceResult> {
    const result = (await this.request('make_invoice', {
      amount: amountSats * 1000,
      description: description.slice(0, 200),
    })) as MakeInvoiceResult;
    if (!result?.invoice || !result?.payment_hash) {
      throw new NwcError('Internal', 'the wallet returned an incomplete invoice');
    }
    return result;
  }

  async payInvoice(invoice: string): Promise<PayInvoiceResult> {
    const result = (await this.request('pay_invoice', { invoice })) as PayInvoiceResult;
    if (!result?.preimage) throw new NwcError('Internal', 'the wallet did not return a preimage');
    return result;
  }

  async lookupInvoice(params: { payment_hash?: string; invoice?: string }): Promise<LookupInvoiceResult> {
    return (await this.request('lookup_invoice', params)) as LookupInvoiceResult;
  }

  /** True when the wallet reports this invoice as settled. */
  static isSettled(result: LookupInvoiceResult | null | undefined): boolean {
    if (!result) return false;
    return result.settled === true || result.state === 'settled';
  }

  async getBalance(): Promise<BalanceResult> {
    return (await this.request('get_balance', {})) as BalanceResult;
  }

  close(): void {
    try {
      this.pool.close(this.conn.relays);
    } catch {
      /* already closed */
    }
  }
}

function mapErrorCode(code: string): NwcErrorCode {
  switch (code) {
    case 'RATE_LIMITED':
      return 'RateLimited';
    case 'NOT_FOUND':
      return 'NotFound';
    case 'INTERNAL':
      return 'Internal';
    default:
      return 'Rejected';
  }
}
