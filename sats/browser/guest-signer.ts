/**
 * Signing without a browser extension.
 *
 * A NIP-07 extension is the right way to hold a Nostr identity, but it cannot be assumed: a judge
 * may open the app on a machine with no Alby or nos2x, and without a key they cannot join a circle
 * at all. This module does the signing locally instead, with a throwaway key that the page keeps in
 * sessionStorage. It is bundled to `public/vendor/guest-nostr.js` (see the build script in
 * package.json) so the browser never needs a CDN or an import map.
 *
 * The key is deliberately a *guest*: it lives for one tab, the page says so, and it is never a
 * substitute for the extension when one is installed.
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from 'nostr-tools/utils';

/** A fresh 32-byte secret, hex encoded, ready for sessionStorage. */
export function generateSecretKeyHex(): string {
  return bytesToHex(generateSecretKey());
}

/** The x-only public key (64 hex chars) for a secret, which is what a server verifies against. */
export function getPublicKeyHex(secretHex: string): string {
  return getPublicKey(hexToBytes(secretHex));
}

/** Sign an event template exactly as a NIP-07 extension would, and return the signed event. */
export function signEvent(template: Record<string, unknown>, secretHex: string) {
  return finalizeEvent(template as Parameters<typeof finalizeEvent>[0], hexToBytes(secretHex));
}
