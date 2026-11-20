# Security notes

Zappot moves members' sats for the whole life of a circle through the member's own Lightning wallet, never a custodian. The design keeps the attack surface small and the rules explicit.

## Design choices

- **No custody, no seed, no admin keys.** The coordinator never holds a private key or a wallet seed. Its only power over money is the NWC (NIP-47) grant's `pay_invoice`, used only to pay a member's invoice for exactly what the circle owes them. It cannot move funds any other way, and there is no owner or upgrade path: the rules are the rules.
- **Identity is a Nostr key.** Every action is a Nostr event signed by the acting member's key — a NIP-07 extension, or a Guest Nostr key minted in the tab. No email, phone number or name is collected anywhere.
- **Signed, bound, single-use events.** The coordinator verifies the signature *and* that the event id is the real hash of its contents, so a captured request cannot be edited. Events carry `action` and `circle` tags, must be within 300 s, and each event id is used once — replays are refused.
- **Payouts match to the satoshi.** A payout is paid only if the member's BOLT-11 invoice asks for *exactly* the claimable balance. A wallet pays whatever the invoice says, so this check is the only thing between a member and the pot.
- **Collateral and a winner's bond.** Missed payments are covered from collateral first, then from the winner's bond; a member who can no longer be covered is marked defaulted, cannot win, and is excluded from dividends.
- **Pull payments.** Settling a round only credits balances; each member takes their own money with their own invoice, so one broken invoice cannot lock the circle.
- **Atomic state.** Circle state is one JSON file, written atomically (write + rename) under a serialised queue, so a crash cannot tear a circle in half.
- **No secrets in logs or state.** The NWC connection string is parsed once, never logged, never serialised into state, never served. Logs carry an error code and message, never a request body.

## Threat model

| Attack | Mitigation |
|---|---|
| Impersonate another member | Signature plus content-hash verification on every event. |
| Replay or edit a captured request | `action` / `circle` tags, a 300 s window, one-time event ids. |
| Claim more than owed | Payout invoice amount must equal the claimable balance, to the satoshi. |
| Take a pot and stop paying | Winner's bond held back (capped at what is owed), then collateral; persistent defaulters cannot win and get no dividends. |
| Operator drains the wallet | The grant can only `pay_invoice`, and only to member invoices — but an operator *can* pay themselves. Mitigation: grant a low-balance test wallet, never a main one. |
| Leak secrets or personal data | Connection string never logged, stored, or served; members are public keys only. |

## Evidence

- `npm test` in `sats/`: **33 tests, all passing**, no network and no wallet required —
  `circle.test.ts` (rules, coverage, bond cap, auction ordering, exact-match payout, cancel),
  `bolt11.test.ts` (amount parsing, tampered checksums, exact-match checks), `auth.test.ts`
  (signatures, staleness, tampering, replays, wrong identity), `guest-signer.test.ts` (Guest Nostr
  key acceptance and binding), `practice-identity.test.ts` (practice seating and bot auction) and
  `record-fallback.test.ts` (record-without-wallet allowed only on practice circles).
- Every scenario that settles a round asserts `inSats − paidOutSats − owedSats === 0`: no satoshi is created or stranded.
- Real Lightning payments (`make_invoice`, `pay_invoice`, `lookup_invoice` against a live wallet) are **not** exercised by the suite — run `npm run nwc:smoke` before a live demo.

## Known limitations

- **Single point of liveness.** The coordinator can refuse to serve (though it cannot take funds). There is no relay-side inbox or federation: two coordinators do not share state.
- **An operator with the NWC grant can pay an invoice to themselves.** Inherent to any NWC-backed service; mitigate by granting a low-balance test wallet (the default `faucet.nwc.dev` wallet), never a main one.
- **Practice circles use server-held throwaway identities**, so anyone can act as a practice member. That is fine because those circles exist to be played with; real circles refuse demo identities outright (`503`).
- **A payout is paid then recorded.** A crash between the two could pay twice. Fix: store the preimage before crediting.
- **No expired-invoice check.** The wallet rejects a stale invoice, which surfaces as a failed payout rather than a loss.
- **Savings scores are computed by this coordinator.** They are not yet anchored as signed Nostr notes, so they are portable in shape but not yet independently verifiable.
- **Wolof strings are templates** written by a non-native speaker and should be reviewed before a public run.
- **Collateral reduces risk, it does not remove it.** If a winner stops paying and their collateral and bond run out, the members paid last receive less.
- **No external audit.** This is hackathon code without a third-party audit.
