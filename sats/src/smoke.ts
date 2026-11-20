/**
 * A read-only check that the wallet answers.
 *
 *   npm run nwc:smoke
 *
 * It reads the balance and asks for a 1 sat invoice, then looks that invoice up. Nothing is paid, so
 * running it costs nothing. The connection string is never printed.
 */

import { loadEnv, nwcConnection, nwcError } from './env.ts';
import { NwcClient } from './nwc.ts';

loadEnv();

const conn = nwcConnection();
if (!conn) {
  console.error(`No usable wallet: ${nwcError() ?? 'set NWC_URI in sats/.env'}`);
  process.exit(1);
}

console.log(`wallet ${conn.walletPubkey.slice(0, 12)}… via ${conn.relays.join(', ')}`);

const client = new NwcClient(conn, { timeoutMs: 30_000 });
try {
  const balance = await client.getBalance();
  console.log(`balance ${(balance.balance / 1000).toLocaleString('en-US')} sats`);

  const invoice = await client.makeInvoice(1, 'Zappot Sats connectivity check');
  console.log(`issued a 1 sat invoice (${invoice.payment_hash.slice(0, 16)}…)`);

  const state = await client.lookupInvoice({ payment_hash: invoice.payment_hash });
  console.log(`invoice state: ${state.state ?? (state.settled ? 'settled' : 'pending')}`);
  console.log('NWC is working.');
} catch (e) {
  console.error(`${(e as Error).name}: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  client.close();
}
