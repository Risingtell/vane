# Feedback on the Somnia reactivity precompile and the DreamDEX SDK

Submitted as the optional *"feedback report regarding SDK and documentation"*.

Everything below was measured against live Shannon while building [Vane](README.md), an agent
that the chain itself wakes. Each item cost real building time, and none of it is in the docs.
The measurements and the exact commands are in `SPIKE-FINDINGS.md`.

Ordered by how much time each one costs a new builder.

---

## 1. Roughly half of matching logs never produce a wake

**The most important one.** With a subscription armed on `BinaryMarketsModule`, the module's own
logs were counted against the handler's own on-chain reaction to them over the same block range:

| Over ~13 minutes of blocks | |
|---|---|
| Matching logs emitted by the module | 58 |
| Times the handler actually ran | 30 |
| **Delivered** | **52%** |

This is not the handler declining to act. The wake counter increments before any branch, and
every path emits an event. The missing ones produced nothing at all.

Ruled out, each against live data:

- **Not a per-transaction cap.** A range with 4 matching logs across 2 transactions produced
  exactly 4 wakes, so delivery is per log.
- **Not the block gas limit.** The blocks whose logs were dropped were **0.9% and 1.2% full**
  against a 15,000,000,000 limit.
- **Not a handler revert**, and **not the subscription lapsing** (both stayed registered, and
  other logs in the same minutes woke it normally).

The pattern that correlates is that dropped logs sat **deep inside large, log-heavy
transactions**. One dropped batch was a single transaction using 83M gas and emitting 87 logs,
with the matching entries at positions 10, 23, 50 and 77.

**Why it matters:** the natural way to read the reactivity docs is as a guaranteed callback. Built
that way, an agent silently misses events and there is nothing in any log to say so. We only found
it because an agent sat 22 minutes doing nothing it should have done.

**Suggested fix, in order of preference:** deliver reliably; or document the limit plainly with
its cause; or expose a way for a subscriber to detect a missed wake, so it can be recovered from.

## 2. `MarketCreated` and friends cannot be decoded from anything public

To react to a new market you need the event's shape. Every obvious route is closed:

- `BinaryMarketsModule` is a **proxy**. The explorer's `getabi` returns the proxy ABI, which
  carries none of the events.
- The EIP-1967 implementation (`0xdf87ac5c4760e2f1dd78e054ce0629a26a4ca5ca`) is **not verified**,
  so there is no ABI there either.
- The topic0 hashes are in **no public signature database**. openchain.xyz returns empty for all
  of them.
- The developer docs do not list event signatures.

What worked was `npm pack @somnia-chain/markets-sdk`, then hashing every event in
`dist/eventsAbi.js` and matching against topic0s pulled from live logs.

**Suggested fix:** verify the implementation contract, or publish a topics table in the docs. A
one-page list of topic0 to signature would remove this entirely.

## 3. The venue id is the only thing separating real markets from test ones

`MarketCreated` fires for **"Pricefeed test"** markets from the same module, in the same bursts,
in the same transactions as real ones. Measured live, they are identical in every field an agent
would naturally filter on:

| | Real DreamDEX | Pricefeed test |
|---|---|---|
| `marketType` | 0 (BINARY) | 0 (BINARY) |
| `collateral` | tUSDC `0x70a8…5d8E` | tUSDC `0x70a8…5d8E` |
| `outcomeSlotCount` | 2 | 2 |
| **`operatorId`** | **2** | **4** |
| **`venueId`** | **`0x679795a0…35e8a28c`** | **`0x1a1e6821…8a5a050f`** |

An agent filtering on market type or on the collateral trades the test markets and never notices.
The bot kit's `packages/ec-core/src/markets.ts` does warn that the venue is the scoping key, and
that the deployment manifest's "active" venue disagrees with where live markets are, but that
warning is in a source comment rather than in the docs.

**Suggested fix:** state the DreamDEX venue id in the developer docs, and say plainly that test
markets share the module.

## 4. A flat order lifetime is a bug, and the error says nothing

`placeBinaryOrder` reverts **`OrderExpiryBeyondMarket()`** (selector `0xd3dea628`) if the order
would outlive its market. It reverts with no reason string, so from outside it is indistinguishable
from any other rejection.

This is nastier than it sounds because of *when* it appears. An agent tested against one long
window works perfectly for hours. Point it at the five-minute windows and **every order fails**,
with nothing anywhere explaining why.

Recovering the cause meant simulating the call with `eth_call`, taking the four-byte selector out
of the revert data, and hashing the SDK's `contractErrorsAbi` against it.

**Suggested fix:** mention in the order-placement docs that expiry is bounded by the market, and
ideally include the error selectors in the docs so a revert can be read without this detour.

## 5. Two smaller ones

**A subscription owner must hold at least 32 STT, and below it `subscribe` reverts with empty
revert data.** 31 fails, 32 passes, and there is nothing to decode and nothing pointing at a
balance. This is the single most confusing failure a new builder will hit.

**`eth_getLogs` is capped at 1000 blocks on a chain making ~15 blocks a second.** A log tail
therefore reaches back barely over a minute, and a poller on any sane interval **silently
truncates** rather than erroring. Anything that must survive being read later belongs in contract
state or in the indexer.

## 6. One thing that is genuinely good

The reactivity precompile is the most interesting primitive we have built on this year. A
subscription stored in chain state that invokes a contract is a real answer to the keeper problem,
and the fact that an agent can exist with no process anywhere is not possible on the chains we
have used before. The `somnia_reactivityGetSubscriptions` and `…GetSubscriptionInfo` methods are
also exactly right: they let anyone verify the claim from outside, with no trust in the builder.

The gaps above are documentation and reliability gaps around a good primitive, not problems with
the idea.

---

Vane: https://github.com/Risingtell/vane · console https://vane-console.vercel.app
