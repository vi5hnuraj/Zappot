# Zappot Sats

The Zappot coordinator: rotating savings circles that settle in satoshis over **Lightning**, coordinate on **Nostr**, and are nudged by an **AI coordinator**.

Everyone contributes the same amount each round and one member takes the whole pot — in join order, or by auction when someone needs the money sooner and is willing to pay the others for it. It is the same economic object as a *tanda*, *susu*, *hui*, *arisan* or *chit fund*: the way most people without access to credit buy a motorbike, stock a shop, or pay school fees.

It fails the same way everywhere: someone takes the pot early and stops paying. Zappot answers that with rules instead of trust — collateral, a winner's bond, and a public savings record — and settles in sats so a member needs nothing but a wallet.

---

## How the three pillars are used

| Pillar | What it does here | Where |
|---|---|---|
| **Bitcoin / Lightning** | Every round is denominated in sats. Contributions are paid to a BOLT-11 invoice; payouts are paid to the member's own invoice, for exactly the amount owed. | `src/nwc.ts`, `src/bolt11.ts` |
| **Nostr + NWC** | A member *is* a Nostr key — no email, no account. Each circle is published as an addressable note (kind 30078). NWC (NIP-47) reaches the wallet over relays, so the coordinator never holds a seed and never opens a port. | `src/nostr.ts`, `src/nwc.ts` |
| **AI** | Reminders in French, English and Wolof, a plain-language briefing, anomaly flags on a round, and one-sentence explanations of a savings record. | `src/ai.ts` |

The model never touches money. It cannot pay an invoice, settle a round or change a rule: it reads public circle state and writes text. With no API key every AI function still answers, from templates and deterministic rules.

---

## Architecture

```
   member's phone                  coordinator (this process)              Lightning
  ┌───────────────┐               ┌──────────────────────────┐            ┌─────────┐
  │ public/app.js │  signed event │  src/server.ts           │  NIP-47    │  NWC    │
  │ NIP-07 signer │──────────────►│   auth.ts    (verify)    │───────────►│ wallet  │
  │ Guest key     │               │   circle.ts  (rules)     │  encrypted │         │
  └───────┬───────┘               │   store.ts   (atomic JSON│  over relay│         │
          │                       └────────────┬─────────────┘            └─────────┘
          │ kind 30078 note                    │ publish
          └──────────────────► Nostr relays ◄──┘
```

- **Rules** live in `circle.ts`, pure and I/O free: collateral, bond, auction or join order, default handling, pull payments.
- **Sats** move only when the wallet says an invoice settled. A payout is paid only if the member's invoice asks for *exactly* what the circle owes them.
- **State** is one JSON file, written atomically (write + rename) under a serialised queue.

### Source map

| File | Responsibility |
|---|---|
| `src/server.ts` | HTTP API, static client, wiring |
| `src/circle.ts` | Pure rules: join, contribute, bid, settle, payout, cancel |
| `src/auth.ts` | Nostr event verification, binding, replay protection |
| `src/nwc.ts` | NIP-47 client: `make_invoice`, `lookup_invoice`, `pay_invoice` |
| `src/bolt11.ts` | Amount decoding and exact-match payout checks |
| `src/store.ts` | Atomic JSON persistence |
| `src/reputation.ts` | Deterministic savings score from completed circles |
| `src/ai.ts` | Reminders, briefing, flags, score prose — template fallback |
| `src/nostr.ts` | Circle announcements as kind 30078 notes |
| `public/` | The client: one HTML file, one JS file, one stylesheet |

---

## Quick start

```bash
cp .env.example .env
npm install
npm start          # http://localhost:8788
```

Requires **Node 22.6+**. Then add a wallet to `.env`:

```
NWC_URI=nostr+walletconnect://…?relay=wss%3A%2F%2F…&secret=…
```

**[faucet.nwc.dev](https://faucet.nwc.dev)** hands out free dummy NWC sub-wallets with test sats (balances exist only inside the faucet, so nothing real can be lost):

```bash
curl -X POST 'https://faucet.nwc.dev?balance=10000'
```

Paste the returned connection string into `NWC_URI`. With your own wallet (Alby Hub, Coinos, Phoenix, LNbits…) the grant needs `make_invoice`, `lookup_invoice` and `pay_invoice`. **Never commit `.env`** — it is git-ignored.

Check the wallet answers without spending anything (reads balance, issues but does not pay a 1 sat invoice):

```bash
npm run nwc:smoke
```

Optional AI settings — with no key the coordinator uses templates instead:

```
OPENAI_API_KEY=
OPENAI_BASE_URL=https://freebuff.com/api/v1/paid
OPENAI_MODEL=gpt-4o-mini
```

---

## The three-minute demo

1. Open the app and press **Create circle**, keeping **Practice circle** ticked: the coordinator adds simulated members so one person can play a whole circle.
2. Press **Fill the open seats**. The circle fills and starts.
3. Press **Pay this round**. With a wallet, the coordinator asks your wallet for a real BOLT-11 invoice through NWC; pay it with any Lightning wallet.
4. Press **Members pay** so the other seats contribute.
5. Press **Close round**. The pot is credited to the winner — you, if you outbid them in auction mode.
6. Take the pot: paste your own invoice and press **Get paid**, or press **No wallet? Record the payout** to book it without moving sats.
7. Press **Write me a reminder** and switch between Français, English and Wolof.

Every step lands in the **Transactions** panel with its proof — payment hash and preimage for real sats, or `recorded · no sats moved`. `Sats in − paid out − owed` is always zero.

With **no wallet connected**, steps 3–6 stay walkable: a practice circle records the contribution and the payout instead of invoicing them, and says so in the toast and the log. That path exists so the whole loop can be tried before a wallet exists. A **real** circle never takes it and answers `503`.

---

## Security by design

**Threat model — who could take money they are not owed, and what stops them:**

| Attack | What stops it |
|---|---|
| Claim to be another member | Every action carries a Nostr event signed by that member's key; the coordinator verifies the signature *and* that the event id is the real hash of its contents, so a captured request cannot be edited. |
| Replay of a captured request | Events carry `action` and `circle` tags, must be within 300 s, and each event id is used once. |
| Ask for a bigger payout than owed | The coordinator decodes the amount from the member's BOLT-11 invoice and requires it to equal the claimable balance exactly (`src/bolt11.ts`). A wallet pays whatever the invoice says, so this check is the only thing between a member and the pot. |
| Take a pot and stop paying | A winner's bond is held back, capped at what they still owe; missed rounds are covered from collateral first, then the bond; a member who cannot cover a round is marked defaulted, cannot win, and is excluded from dividends. |
| Coordinator steals the float | It holds no seed and no keys. Its only power over money is the NWC grant's `pay_invoice`, and it can only pay invoices to members — but **an operator with that grant can pay an invoice to themselves**. That is inherent to any NWC-backed service; the mitigation is to grant a low-balance wallet, not a main one. |
| Leakage of secrets or PII | The connection string is parsed once, never logged, never serialised into state, never served. Logs carry an error code and message, never a request body. Members are public keys; no email, phone or name is collected. |

**Deliberate limits.** The coordinator is a single point of liveness (it can refuse to serve, though it cannot take funds). Practice circles use server-held throwaway identities, so anyone can act as a practice member — that is fine because those circles exist to be played with, and real circles refuse demo identities outright.

---

## Tests

```bash
npm test
```

33 tests, no network and no wallet required:

- **`test/circle.test.ts`** — a full fixed-order cycle paying every pot; a missed round covered from collateral and the default that follows when cover falls short; the bond capped at what is still owed; an auction discount split with no dust; bid ordering and caps; a round refusing to close early; a payout that must match to the satoshi and must not touch collateral mid-circle; cancel and refund; configuration validation.
- **`test/bolt11.test.ts`** — amount extraction across units, amountless invoices, tampered checksums, sub-satoshi amounts, exact-match payout checks.
- **`test/auth.test.ts`** — signed actions accepted; wrong action, circle or staleness refused; tampered payloads refused; replays refused; wrong identity refused.
- **`test/guest-signer.test.ts`** — a Guest Nostr key signs events the coordinator accepts, bound to their action and circle.
- **`test/practice-identity.test.ts`** — practice circles seat the guest key that joins them; a visitor with no key still creates and joins with the demo identity; an auction runs against bots.
- **`test/record-fallback.test.ts`** — with no wallet, a practice circle records a contribution and a payout without moving sats, while a real circle refuses that path.

Every scenario that settles a round asserts `inSats − paidOutSats − owedSats === 0`: no satoshi is created or stranded.

---

## What is verified, and what is not

**Verified in this build:** the full rule set (33 tests); the HTTP flow end to end — create, join, bot contribute, early-settle refusal, settlement after a deadline with a defaulting member covered by collateral, flags, reputation; the simulated practice path (contribute and payout with no wallet); and the server booting and serving the app.

**Not verified here: real Lightning payments.** No NWC wallet was connected in this environment, so `make_invoice`, `pay_invoice` and `lookup_invoice` have not been exercised against a live wallet. Run `npm run nwc:smoke` with your connection string before demoing, then walk the three-minute demo once with 21 sat rounds.

Also not done yet:

- No check that a payout invoice has not expired (the wallet rejects a stale one, which surfaces as a failed payout rather than a loss).
- A payout is paid then recorded; a crash between the two could pay twice. Fix: store the preimage before crediting.
- Circles are read by id from one coordinator; there is no relay-side inbox or federation, so two coordinators do not share state.
- Wolof strings are templates written by a non-native speaker and **should be reviewed before a public run**.
- The savings record is not yet anchored as a signed Nostr note; reputation is computed from this coordinator's completed circles.

---

## Next iteration

1. **Anchor reputation on Nostr** — publish each member's record as a signed note, so the score is portable between coordinators and verifiable without trusting one.
2. **Federate** — a circle announced on Nostr with a `d` tag any coordinator can settle, with a quorum of member signatures per round.
3. **Retry-safe payouts** (preimage first), expired-invoice rejection, and a hold-invoice flow so a member's payout can be claimed later rather than pushed immediately.
4. **Offline-friendly UX** — render reminders as a shareable image for WhatsApp, where most of the group actually coordinates.
5. **Native Wolof review** and a Pular version.

## Metrics to track

| Metric | Why it matters |
|---|---|
| Circles completed vs. created | The real measure of whether a group trusts the rules enough to finish. |
| Defaults per circle, and sats recovered from collateral | Whether the collateral is priced right. |
| Median time from round deadline to settlement | How much a human coordinator is still needed. |
| Invoice paid → round settled latency | Whether the Lightning path feels instant on a mid-range phone. |
| Reminder → payment conversion, by language | Whether the AI reminders are worth their cost. |
| Repeat members (same npub in a second circle) | The only honest retention signal for a savings product. |

## License

MIT © 2026 Vishnuraj. See [LICENSE](../LICENSE).
