/**
 * Environment loading without a dependency.
 *
 * `.env` is read once, never logged, and never served. Values already in the process environment win,
 * so a container or a CI secret store can override the file.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNwcUri, type NwcConnection } from './nwc.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const rootDir = join(here, '..');

export function loadEnv(): void {
  const file = join(rootDir, '.env');
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function relays(): string[] {
  return (process.env.NOSTR_RELAYS ?? 'wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band')
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.startsWith('wss://') || r.startsWith('ws://'));
}

export function port(): number {
  const n = Number(process.env.PORT ?? 8788);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 8788;
}

export function publicUrl(): string {
  return (process.env.PUBLIC_URL ?? `http://localhost:${port()}`).replace(/\/$/, '');
}

export function dataDir(): string {
  return process.env.DATA_DIR?.trim() || 'data';
}

/** Demo mode lets the practice circle's bot members act without a Nostr extension. */
export function demoMode(): boolean {
  return (process.env.DEMO_MODE ?? '1') !== '0';
}

/**
 * The NWC connection string, parsed. Returns null when it is missing or malformed instead of
 * throwing: the app still runs and shows what is missing, which is better than a dead server.
 */
export function nwcConnection(): NwcConnection | null {
  const uri = process.env.NWC_URI?.trim();
  if (!uri) return null;
  try {
    return parseNwcUri(uri);
  } catch {
    return null;
  }
}

export function nwcError(): string | null {
  const uri = process.env.NWC_URI?.trim();
  if (!uri) return 'no wallet connected yet';
  try {
    parseNwcUri(uri);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
