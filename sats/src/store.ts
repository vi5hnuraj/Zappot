/**
 * JSON-file persistence.
 *
 * One process owns the file, writes are serialised and atomic (write, then rename), so a crash
 * mid-run cannot leave a half-written circle behind. This is the shape a Postgres table would take:
 * circles keyed by id, plus the coordinator's Nostr identity.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Circle } from './circle.ts';
import type { Identity } from './nostr.ts';
import { identityFromSecretKey } from './nostr.ts';
import { createIdentity } from './nostr.ts';

export type Db = {
  circles: Record<string, Circle>;
  identity?: { secretKeyHex: string; createdAt: number };
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export class Store {
  dir: string;
  file: string;
  data: Db;
  #queue: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, 'circles.json');
    this.data = { circles: {} };
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Db;
      this.data = { circles: parsed.circles ?? {}, identity: parsed.identity };
    } catch {
      this.data = { circles: {} };
    }
  }

  /** The coordinator's Nostr key, created once and kept on disk. */
  identity(): Identity {
    if (!this.data.identity) {
      const fresh = createIdentity();
      this.data.identity = { secretKeyHex: bytesToHex(fresh.secretKey), createdAt: Math.floor(Date.now() / 1000) };
      void this.flush();
      return fresh;
    }
    return identityFromSecretKey(hexToBytes(this.data.identity.secretKeyHex));
  }

  list(): Circle[] {
    return Object.values(this.data.circles).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Circle | undefined {
    return this.data.circles[id];
  }

  async put(circle: Circle): Promise<void> {
    this.data.circles[circle.id] = circle;
    await this.flush();
  }

  /** Serialise writes so two requests cannot interleave a rename. */
  async flush(): Promise<void> {
    this.#queue = this.#queue.then(async () => {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      await rename(tmp, this.file);
    });
    await this.#queue;
  }
}
