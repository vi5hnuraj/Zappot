import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bech32 } from '@scure/base';
import { InvoiceError, decodeInvoiceAmountSats, invoiceAsksFor } from '../src/bolt11.ts';

// A syntactically valid invoice for each amount: bech32 gives it a correct checksum.
const words = Array.from({ length: 80 }, (_, i) => i % 32);
const invoice = (hrp: string) => bech32.encode(hrp, words, 4000);

test('reads the amount in satoshis', () => {
  assert.equal(decodeInvoiceAmountSats(invoice('lnbc2500u')), 250_000);
  assert.equal(decodeInvoiceAmountSats(invoice('lnbc10u')), 1_000);
  assert.equal(decodeInvoiceAmountSats(invoice('lnbc1m')), 100_000);
  assert.equal(decodeInvoiceAmountSats(invoice('lnbc10n')), 1);
  assert.equal(decodeInvoiceAmountSats(invoice('lntb21u')), 2_100);
  assert.equal(decodeInvoiceAmountSats(invoice('lnbcrt5u')), 500);
});

test('an amountless invoice has no amount to check against', () => {
  assert.equal(decodeInvoiceAmountSats(invoice('lnbc')), null);
});

test('a tampered or malformed invoice is refused', () => {
  const good = invoice('lnbc2500u');
  const tampered = good.slice(0, -1) + (good.endsWith('q') ? 'p' : 'q');
  assert.throws(
    () => decodeInvoiceAmountSats(tampered),
    (e: unknown) => e instanceof InvoiceError,
  );
  assert.throws(
    () => decodeInvoiceAmountSats('notaninvoiceatall'),
    (e: unknown) => e instanceof InvoiceError,
  );
  assert.throws(
    () => decodeInvoiceAmountSats(''),
    (e: unknown) => e instanceof InvoiceError,
  );
});

test('amounts below a satoshi are refused rather than rounded', () => {
  assert.throws(
    () => decodeInvoiceAmountSats(invoice('lnbc1p')),
    (e: unknown) => e instanceof InvoiceError,
  );
});

test('a payout invoice must ask for exactly what is owed', () => {
  assert.equal(invoiceAsksFor(invoice('lnbc25u'), 2_500), true);
  assert.equal(invoiceAsksFor(invoice('lnbc25u'), 2_501), false);
  assert.equal(invoiceAsksFor(invoice('lnbc'), 0), false);
});

test('the lightning: prefix and upper case are tolerated', () => {
  const good = invoice('lnbc2500u');
  assert.equal(decodeInvoiceAmountSats(`lightning:${good.toUpperCase()}`), 250_000);
});
