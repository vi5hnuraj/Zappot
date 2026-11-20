/**
 * Reading the amount out of a BOLT-11 invoice.
 *
 * This is a security check, not a convenience. The coordinator pays a member their claimable
 * balance with `pay_invoice`, and a wallet pays whatever the invoice says — so a member owed 500
 * sats could otherwise hand over a 1,000,000 sat invoice and drain the circle. Every payout
 * invoice must be checksum-valid and encode exactly the amount owed.
 *
 * Only the amount is decoded. The signature and route are the paying wallet's problem.
 */

import { bech32 } from '@scure/base';

const MSAT_PER_UNIT: Record<string, number> = {
  '': 100_000_000_000, // 1 BTC in msat
  m: 100_000_000,
  u: 100_000,
  n: 100,
  p: 0.1,
};

export class InvoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceError';
  }
}

const CURRENCIES = ['bcrt', 'tbs', 'bc', 'tb', 'sb'];

function splitHrp(hrp: string): { prefix: string; amount: string | null } {
  if (!hrp.startsWith('ln')) throw new InvoiceError('not a Lightning invoice');
  const rest = hrp.slice(2);
  const currency = CURRENCIES.find((c) => rest.startsWith(c));
  if (!currency) throw new InvoiceError('unknown Lightning network prefix');
  const amount = rest.slice(currency.length);
  return { prefix: currency, amount: amount === '' ? null : amount };
}

/**
 * The invoice's amount in satoshis, or `null` for an amountless invoice (which cannot be used for a
 * payout, because there would be nothing to check it against).
 */
export function decodeInvoiceAmountSats(invoice: string): number | null {
  const cleaned = invoice.trim().replace(/^lightning:/i, '').toLowerCase();
  if (cleaned.length < 20) throw new InvoiceError('that does not look like a Lightning invoice');
  if (cleaned.length > 2000) throw new InvoiceError('that invoice is too long');

  let decoded: { prefix: string; words: number[] };
  try {
    decoded = bech32.decode(cleaned, 4000);
  } catch {
    throw new InvoiceError('the invoice checksum is wrong; copy the whole invoice again');
  }

  const { amount } = splitHrp(decoded.prefix);
  if (amount === null) return null;
  if (!/^\d+(m|u|n|p)?$/.test(amount)) throw new InvoiceError('the invoice amount is malformed');

  const unit = amount.slice(-1);
  const hasMultiplier = unit in MSAT_PER_UNIT && unit !== '';
  const digits = hasMultiplier ? amount.slice(0, -1) : amount;
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) throw new InvoiceError('the invoice amount is out of range');

  const msat = value * MSAT_PER_UNIT[hasMultiplier ? unit : ''];
  if (!Number.isFinite(msat) || msat <= 0) throw new InvoiceError('this invoice asks for nothing');
  if (msat % 1000 !== 0) throw new InvoiceError('invoices with fractions of a satoshi are not supported');
  const sats = msat / 1000;
  if (!Number.isSafeInteger(sats)) throw new InvoiceError('the invoice amount is out of range');
  return sats;
}

/** True when the invoice is valid and asks for exactly `expectedSats`. */
export function invoiceAsksFor(invoice: string, expectedSats: number): boolean {
  return decodeInvoiceAmountSats(invoice) === expectedSats;
}
