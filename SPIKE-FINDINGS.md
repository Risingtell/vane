# Day 1 spike findings

Everything here was confirmed against the live Shannon testnet or against shipped package
internals, not from prose documentation.

## Confirmed

**The handler ABI.** The precompile calls `onEvent(address,bytes32[],bytes)` on the handler
contract. Its selector is `0x53edf33d`, which matches the `handler_function_selector` on live
subscription `0x1` read from Shannon via `somnia_reactivityGetSubscriptionInfo`. Source of the
signature: `@somnia-chain/reactivity@0.2.1`, `src/abi/SomniaEventHandler.ts`.

**The precompile ABI.** `subscribe((bytes32[4],address,address,address,address,bytes4,uint64,uint64,uint64,bool,bool))`
returning `uint256`, `unsubscribe(uint256)`, `getSubscriptionInfo(uint256)` returning
`(SubscriptionData, address owner)`. Precompile address `0x0000000000000000000000000000000000000100`.

**Scheduling is expressed as a topic filter, not a parameter.** The `scheduleAt*` helpers are
ordinary subscriptions whose `emitter` is the precompile itself and whose topics are:

| Helper | topic0 | topic1 |
|---|---|---|
| `scheduleAtTimestamp` | `Schedule(uint256)` = `0x67aa3d752967d87d8944b9c7adf73172518777fa4703f336edee81f0736d8987` | timestamp in **milliseconds** |
| `scheduleAtBlock` | `BlockTick(uint64)` = `0x758ef516c6953f00626f7bc382a398f5ddc4e9b44c86035e7c0c0a7b8a9b46ae` | block number, or zero for any |
| `scheduleAtEpoch` | `EpochTick(uint64,uint64)` = `0x2e0c8e351f738401ab3e8e932f7251c170afb7b5539cbab5d24743f09b52aec8` | epoch number |

Milliseconds, not seconds. This is easy to get wrong and the docs do not stress it.

**Subscription owner and handler contract are different things.** On live subscription `0x1` the
owner is `0x12a76e09bae1934265a1aea2812e0c772f372f8d` (a funded EOA) while the handler contract
`0xf84f7633bd403967999b06911f978a74326f547e` holds **0 STT**. Handler execution is billed to the
owner, so the handler itself needs no balance when an EOA owns the subscription.

**Event subscriptions are persistent, scheduled ones are one-shot.** This is the most important
design consequence. A subscription filtered on a real contract's event stays armed and re-fires on
every matching log. Only `scheduleAt*` subscriptions are removed after firing. So an agent driven by
DreamDEX's own market events needs no timer and no re-arm step at all.

## Settled: the 32 STT floor is enforced by the chain, not just the SDK

`@somnia-chain/reactivity` refuses to subscribe under 32 SOMI, and that turns out to mirror a real
protocol rule. Proven two ways against live Shannon:

1. The identical `subscribe` calldata sent via `eth_call` **succeeds** from
   `0x12a76e09bae1934265a1aea2812e0c772f372f8d` (holds ~1.6e42 STT) and **reverts with empty data**
   from our own 0.4 STT account and our 0.5 STT contract.
2. Replaying the same call with `eth_call` balance state overrides puts the boundary exactly at 32:

   | Owner balance | `subscribe` |
   |---|---|
   | 31 STT | reverts |
   | 32 STT | succeeds |
   | 33 STT | succeeds |
   | 40 STT | succeeds |

The revert carries no reason data, which is what a precompile rejection looks like and makes this
very hard to diagnose from the outside. **This is the single most valuable thing to report back to
Somnia**: an empty revert on an undocumented balance floor.

Consequence for design: whoever owns a subscription must hold at least 32 STT. If the agent contract
arms its own subscriptions it must hold 32 STT itself; if an EOA arms them, the EOA must. Subscription
creation also costs 210,000 gas on top.

## Validated, blocked only on funding

With a balance override putting 33 STT on the deployed spike, both arm paths on our own contract
return OK against the live precompile:

- `start(60)` (one-shot timer subscription)
- `armOnEvent(BinaryMarketsModule, any)` (persistent event subscription)

So the struct encoding, topic filters, handler selector and handler address are all correct and
accepted by the real precompile. The mechanism is sound. The only thing preventing a real
subscription is holding 32 STT.

Deployed spike: `0xC52486aEA8DF706a253fCC862e0FEF9374A4D9c4` on Shannon.

## Gotchas worth reporting back to Somnia

1. A local EVM (Hardhat/EDR) reserves `0x0100` and intercepts calls to it, so `hardhat_setCode`
   cannot be used to mock the precompile at its real address. Handler contracts need the address
   behind an overridable getter to be testable off-chain. Nothing in the docs mentions this.
2. `@somnia-chain/reactivity` ships no Solidity. The docs reference a `SomniaEventHandler` base
   contract and a `SomniaExtensions` library that are not published anywhere findable, so the
   handler side has to be reconstructed from the TypeScript ABI.
3. `docs.somnia.network/developer/testnet` is a 404 and is linked from the network info page.

## Local test status

`npx hardhat test` 8 passing, `npx tsc --noEmit` clean. Both verified by exit code, not by reading
piped output. The precompile is mocked, so these cover contract logic only. The chain-side claim is
still unproven until the contract is deployed and funded.

---

# Day 1 result: GO. Proven on live Shannon.

The chain woke the deployed contract **78 times** with no bot, no server and no keeper anywhere.
Contract `0xC52486aEA8DF706a253fCC862e0FEF9374A4D9c4`, funded with 40.5 STT to clear the 32 floor.

**Timer mode (one-shot, self-re-arming).** Armed once at a 60s offset, then left alone. The chain
woke it and it put itself back on the clock unaided, with a fresh subscription id each time
(13757859 to 13757957 to 13758010 to 13758055). Only a read-only poller was running locally.

**Event mode (persistent).** Timer stopped (`running: false`), then subscribed to DreamDEX's
`BinaryMarketsModule` at `0x3ecC694Cef705358864a646142ac17A90E29e388`. It kept being woken purely by
real market activity, with no timer and no re-arm step. This is the mode Vane uses.

## Costs, measured

| | STT per wake |
|---|---|
| Timer mode (includes re-subscribing each time) | ~0.00224 |
| Event mode (no re-subscribe) | ~0.00093 |

## Three things that change the design

**1. Event subscriptions fire in bursts, not steadily.** An unfiltered subscription
(`topic0 = 0x0`) on `BinaryMarketsModule` took ~31 wakes in about 55 seconds when a batch of market
windows was created, then sat idle. Vane must filter on a specific `topic0`, not match-any, or it
burns STT on every unrelated log the module emits.

**2. `subscribe` records `msg.sender` as owner, but `unsubscribe` authorises on `tx.origin`.**
Calling `unsubscribe` through the owning contract reverts with empty data, while the identical
`eth_call` with `from` set to the contract succeeds. The only difference is `tx.origin`. So a
contract that owns its own subscriptions **cannot cancel them from a user-initiated transaction**.
This is the most surprising finding here and the strongest item for the feedback report.

**3. Defunding the owner is the working kill switch.** After `withdraw()` took the contract to 0 STT,
wakes stopped at 78 and `somnia_reactivityGetSubscriptions` went to `[]`, so the node evicted the
subscription outright. All 40.5 STT came back.

## Design decision that follows

**The user's EOA should own Vane's subscriptions, not the Vane contract.** This is also exactly what
Somnia's own team does on live subscription `0x1`: a funded EOA owner with a 0-balance handler
contract. It gives us all three properties we need:

- `unsubscribe` works normally, because `tx.origin` is the owner, so users keep a real kill switch
- the 32 STT floor sits on the EOA, and the handler contract needs no balance at all
- no re-arming is required, because event subscriptions are persistent

The self-re-arming timer stays only for the settlement sweep, where a one-shot at expiry is the right
shape.

---

# Day 2: VaneAgent live on Shannon, traded by the chain

`VaneAgent` `0x3395C65933c10c7bf76188C935d2ea59FA439f4D`, factory
`0x23f338ccf8Ee60f2B323f0e7490bf97216eC9619`, subscription `13815812` owned by the
operator EOA. The chain woke the agent 26 times and it placed **5 real orders on the live
DreamDEX book** with nothing running locally. All five show `status: Open`, `rested: true`
in the indexer. Balance moved 200 to 150.0005 tUSDC, exactly 10 per trade, then it stopped
by itself on the 150 reserve.

## Custody: non-custodial is not possible here, so the design removes the danger instead

Both delegation routes are closed on event contracts, confirmed against live Shannon:

| Route | Result |
|---|---|
| Operator permission registry (`setOperatorApprovalGlobal`, selector `0x80054449`) | **Spot only.** The SDK source says a BinaryPool escrows through the module and has no operator gate. |
| `placeBinaryOrderFor(owner, ...)` | Reverts **`OnlyApprovedContracts()`** (`0x3fb0ba2e`) for anyone outside the protocol allowlist, whatever owner is passed. |
| `placeBinaryOrder(...)` | Works, and pulls collateral from `msg.sender` (an unfunded caller reverts `ERC20InsufficientAllowance`). |

So whoever trades must hold the money. Vane answers that with one agent per user and a
withdraw path that is owner-only and unconditional: it does not depend on the strategy,
the operator, the pause flag or the subscription. The operator can trade and nothing else.

## Two bugs that only real integration could have found

**1. Quantity must sit on the venue's lot grid.** `size / price` produced 22,222,222,
which the pool rejected with `InvalidQuantity`. Probing the grid on a live pool: 1000 is
accepted, 100 is not. The agent now rounds DOWN onto the grid (rounding up could spend
past the window budget). Mocks cannot catch this.

**2. The subscription gas limit silently swallows the trade.** Placing one binary order
measured **~3,953,475 gas** on a live pool, and the cost rises with how many book levels
the order walks. A subscription armed with `gasLimit: 3_000_000` still woke the agent
normally, but the inner pool call ran out of gas, and because the placement is wrapped in
`try/catch` it surfaced as an ordinary "pool rejected the order". Nothing anywhere reports
out-of-gas. Raising the limit to 8,000,000 fixed it immediately. **This is the single
easiest way to lose a day on reactivity**, and the best item for the feedback report after
the empty-revert balance floor.

## Confirmed: an EOA-owned subscription really is cancellable

`unsubscribe` from the owning EOA succeeded (`13815080` cancelled). That is the direct
counterpart to the day-one finding that a contract-owned subscription cannot be cancelled
from a user transaction, and it settles the architecture: the operator EOA owns the
subscription, the agent contract holds no STT, and the kill switch works.

## Operating costs, measured

| | cost |
|---|---|
| One wake (event mode, no re-subscribe) | ~0.00093 STT |
| One binary order placement | ~3.95M gas |
| Minimum balance to hold a subscription | 32 STT, chain-enforced |

---

# Day 3: the money comes back, proven live

Both halves of "getting paid" now work against live Shannon.

## Reclaiming escrow

`cancelExpiredOrders(uint128[])` on the pool, ~517k gas for six orders, and it returns escrow to
each order's own OWNER rather than to whoever calls. Ran it against the six dead orders the agent
had left resting and recovered the full **50 tUSDC** (150.00005 back to 200.0).

This is not optional housekeeping. An order past its `expireTimestampNs` still reads `status: Open`
and keeps its collateral until something cancels it, so an agent that never reclaims slowly leaks
its entire balance into dead orders.

## Redeeming a settled position

Full lifecycle on agent `0x0006b8F2757aB6008ea744C8e6357951d63257F9`: deposit 20 tUSDC, mint a
complete set for 10, wait for the oracle to resolve the window, then `sweepSettled`. Result:
**10 tUSDC back, `redeemCount` 1**, balance 10.0 to 20.0. A complete set is worth exactly what it
cost, since one side pays 1 and the other 0.

Order of operations that actually matters:

1. `market.isResolved()` / `isVoided()` first. A voided market pays BOTH sides at 0.5, so both
   positions must be claimed.
2. Winner is the **argmax of `market.payoutNumerators()`**. `winningOutcome()` was removed in
   settlement v3 and reverts.
3. `outcomeToken.setOperator(module, true)` BEFORE redeeming: the module pulls the winning position
   from the holder, so without the grant the redeem reverts. One grant covers every market.
4. `module.redeem(operatorId, venueId, marketId, outcomeIdx, amount)`, keyed by **market id**, never
   by pool, because pools are recycled onto the next window.

## Complete sets are the only way to hold a position on an empty book

The short rolling windows mostly have empty books, so a crossing order has nothing to fill against.
`mintSet` needs no counterparty and is how a maker builds inventory, which makes it the reliable way
to acquire a position for testing settlement.

## Both reclaim and redeem are permissionless on purpose

Neither depends on the operator still existing. If the operator disappears, any passer-by can still
free the owner's collateral and claim their winnings, and both land in the agent rather than with
the caller.

## Indexer gap worth knowing

The redemption is unambiguous on-chain (contract state and balance), but no `RedemptionRecord` row
appeared in the indexer for it. That window came from the `Pricefeed test` series rather than the
production one. For anything a judge will check, use a production-series market.

---

# Day 5: what it costs to leave an agent armed

Re-measured on 27 Aug against the live agent, because the answer decides whether an agent of
this design can simply be left running.

| | measured |
|---|---|
| Wakes delivered | ~2.7 per minute, set by DreamDEX event traffic, not by us |
| A wake that places an order | ~0.0018 STT |
| A wake that stands down on policy | ~0.0011 STT |
| Burn at the observed wake rate | **~4.2 STT per day** |

Shannon's base fee sits flat at 6 gwei and the wake is charged at base plus the subscription's
priority fee, not at its `maxFeePerGas`. So raising or lowering the fee cap in the subscription
does not change the bill, and there is no cheap knob to turn.

Put together with the 32 STT floor, that is the real operational constraint on this design: a
subscription owner holding 46 STT has about **three and a half days** of continuous arming before
it falls under the floor, and a Shannon faucet grant is ~1 STT. An always-on agent needs a funded
operator, which is a sponsor decision, not a code one.

## `eth_getLogs` is capped at 1000 blocks, and Somnia makes ten blocks a second

The node rejects any `eth_getLogs` range wider than 1000 blocks with `block range exceeds 1000`.
At roughly ten blocks per second that is a hundred-second window per call, so a naive log tail
reaches back under two minutes and a UI built on one shows nothing a few minutes after the agent
goes quiet. Anything that has to survive being read later belongs in contract state or in the
indexer, not in a log scan. The console walks ten windows and then falls back to the indexer's
permanent order history.

## `cancelExpiredOrders` returns the escrow exactly, and only for expired orders

Re-proven on 27 Aug on a second, independent run: nine resting orders, six still tracked, one
call, `250.00005 -> 300.0 tUSDC`. Orders past `expireTimestampNs` still report `status: Open` to
the indexer until something cancels them, which is why the balance and not the status is the
thing to measure.

---

# Day 6: the agent moves itself onto new windows

The last thing that still needed a person was pointing the agent at the next market. This is how
that was closed, and the parts that were not obvious.

## The rollover event is `MarketCreated`, and the ABI is not where you would look for it

None of the usual routes work:

- `BinaryMarketsModule` at `0x3ecC694Cef705358864a646142ac17A90E29e388` is a **proxy**. The
  explorer's `getabi` returns the proxy's own ABI, which has no events worth anything. The
  EIP-1967 implementation slot points at `0xdf87ac5c4760e2f1dd78e054ce0629a26a4ca5ca`, and that
  contract is **not verified**, so there is no ABI to fetch.
- The topic0s are in **no public signature database**. openchain.xyz returns empty for every one
  of them.
- The DoraHacks-facing docs do not list them either.

What does work: `npm pack @somnia-chain/markets-sdk`, then hash every event signature in
`dist/eventsAbi.js` and match the hashes against topic0s pulled from live module logs. That
recovers the full shape:

```
MarketCreated(bytes32 indexed marketId, address indexed market, address indexed pool,
  uint256 oracleQuestionId, uint32 operatorId, bytes32 venueId, address creator,
  address collateral, uint256 yesId, uint256 noId, uint64 nonce, uint8 outcomeSlotCount,
  uint8 marketType, uint64 tradingStart, uint64 expiry, uint8 voidPolicy,
  string asset, uint256 strike, string question, bytes context)
```

topic0 `0xb5ec75cdb7dbcd28a5f50d152d8833334525a902ef5332ebc19bcf5c0011f8cd`.

Two more from the same file, useful to anyone indexing this module:
`MarketFinalized(bytes32,address,uint256)` is `0x8f396ac6…`, and
`PoolReleased(bytes32,address,address)` is `0xa389f948…`.

## The decode is cheap, because everything needed is ahead of the strings

**The new pool is `topic3`**, so it costs one word and no decoding at all. And the three fields
that decide whether a window is worth taking all sit in the fixed-width head of the data, before
the dynamic `asset`, `question` and `context`:

| Field | Head slot | Byte range |
|---|---|---|
| `operatorId` | 1 | 32..64 |
| `venueId` | 2 | 64..96 |
| `collateral` | 4 | 128..160 |
| `marketType` | 9 | 288..320 |
| `expiry` | 11 | 352..384 |

So the whole decision is three `abi.decode` calls over calldata slices. No dynamic decoding, no
stack-too-deep, no `viaIR`.

## ⚠ The venue is the ONLY thing that separates real markets from test ones

DreamDEX emits **"Pricefeed test"** markets from the same module, in the same bursts, in the same
transactions as the real ones. Measured live on Shannon, they are identical in every field an
agent would naturally filter on:

| | Real DreamDEX | Pricefeed test |
|---|---|---|
| `marketType` | 0 (BINARY) | 0 (BINARY) |
| `collateral` | tUSDC `0x70a8…5d8E` | tUSDC `0x70a8…5d8E` |
| `outcomeSlotCount` | 2 | 2 |
| **`operatorId`** | **2** | **4** |
| **`venueId`** | **`0x679795a0…35e8a28c`** | **`0x1a1e6821…8a5a050f`** |

An agent that filtered on `marketType` or on the collateral would happily trade the test markets.
The bot kit's own `packages/ec-core/src/markets.ts` says the same thing, and warns against
inferring the venue from the deployment manifest because the manifest's "active" venue disagrees
with where the live markets actually are. Reading the venue out of the event itself avoids both
problems.

## Windows come in a ladder, so a length floor is not optional

Measured from the indexer over 24 hours on the DreamDEX venue:

| Window length | Roughly how often a pair opens |
|---|---|
| 5 minutes | every 5 minutes |
| 15 minutes | every 15 minutes |
| 1 hour | hourly |
| 4 hours | every 4 hours |
| 24 hours | daily |

They all run **side by side** on the same two questions. So "the newest window" is a useless
target: an agent taking whatever arrived last would keep landing on 5-minute books that close
before its own 300-second orders can be reclaimed. Vane takes nothing under `minWindowSeconds`
(600 by default) and, crucially, **only looks for a window when its current one is nearly done**.
Without that second half it would abandon a book it was trading every time the venue opened
anything longer, and end up parked on the daily window.

## Escrow belongs to the pool, not to the agent's idea of "current"

This is the bug that the feature would have introduced. Housekeeping used to reclaim against
`activePool`. Once the agent can move itself, the orders still resting in the previous book are
no longer in `activePool`, and reclaiming against the new one silently frees nothing while the
collateral stays locked in the old one for good. Tracked order ids now carry the pool they were
placed in, and the old book keeps its allowance until nothing of ours is left in it.

## `eth_getLogs` polling cannot keep up with this chain

Worth restating with a number. A watcher polling every 90 seconds and asking for the last 1000
blocks **misses events**: Shannon was measured at roughly **15 blocks per second**, so 90 seconds
is about 1350 blocks and the 1000-block cap silently truncates the range. Poll under 60 seconds,
or use the indexer, which keeps the history permanently.

## ⚠ Roughly HALF of matching logs never produce a wake

The most important thing learned building this, and the one that changed the design.

A subscription on `MarketCreated` was armed and the agent left running. Then the module's own
logs were counted against the agent's own on-chain reaction to them, over the same block range:

| Over ~13 minutes of blocks | |
|---|---|
| `MarketCreated` logs emitted by the module | 58 |
| Roll evaluations the agent actually ran | 30 |
| **Delivered** | **52%** |

This is not the agent rejecting them. Every evaluation, including a rejection, emits a
`RollSkipped`, and the wake counter increments before any branch. The missing ones produced
nothing at all: no wake, no event, no counter movement.

Things that were ruled out, each against live data rather than by reasoning:

- **Not a per-transaction cap.** A sample block range with 4 `MarketCreated` logs across 2
  transactions produced exactly 4 evaluations, so delivery is per LOG, not per transaction.
- **Not the block gas limit.** The blocks whose logs were dropped were **0.9% and 1.2% full**
  against a 15,000,000,000 gas limit. There was room for a thousand wakes.
- **Not a revert in the handler.** A revert would still leave the transaction visible, and the
  handler cannot revert on a business condition by construction.
- **Not the subscription lapsing.** Both subscriptions were still registered on the node
  throughout, and other logs in the same minutes woke the agent normally.

The pattern that does correlate: the dropped logs sat **deep inside large, log-heavy
transactions**. One dropped batch was a single transaction using **83M gas** and emitting **87
logs**, with the four `MarketCreated` entries at positions 10, 23, 50 and 77 (global log indexes
152 to 219). The transactions whose logs were delivered were small ones with two logs.

**What this means for anyone building on reactivity: you cannot treat a subscription as a
reliable message queue.** Design for a wake that may simply not arrive.

Vane's answer is to depend on frequency rather than on any single event. Instead of holding out
for the rare long windows, it accepts any window with at least `minWindowSeconds` (240) left, and
DreamDEX opens a five-minute window every five minutes. At 52% delivery the expected wait for a
usable one is under ten minutes, and missing one costs nothing but a few minutes.

The first version of this feature had a 600-second floor, which only the 15-minute-and-longer
windows clear. It sat for **22 minutes without a single successful roll**, because every eligible
creation in that period happened to be in a dropped batch. That is what the measurement above was
written to explain.

## An order may not outlive its market: `OrderExpiryBeyondMarket()`, selector `0xd3dea628`

This one only appears once an agent starts moving between windows, which is why it survived
every earlier session.

Vane placed every order with a flat 300-second lifetime. On the long window it had been pointed
at by hand, that was always comfortably inside the market, and orders filled. The moment it began
rolling itself onto five-minute windows, **every single order was rejected** while the agent
otherwise behaved perfectly: it woke, it chose the right window, it granted the allowance, and
then logged `pool rejected the order` twenty times in a row.

The pool reverts with a custom error and no reason string, so the rejection is invisible from the
outside. Recovering it took the same trick as the event ABI: simulate the exact call with
`eth_call` from the agent's own address, take the four-byte selector out of the revert data
(`0xd3dea628`), and hash every entry in the markets SDK's `contractErrorsAbi` against it. It is
`OrderExpiryBeyondMarket()`.

**The fix is to clamp the order's expiry to the market's own.** The agent knows the window end
for any window it rolled onto itself, because that value came out of the `MarketCreated` event
that sent it there. Where the window is unknown, because a human pointed it at a pool, it falls
back to the flat lifetime and behaves exactly as before.

Worth stating plainly for anyone else building here: **a flat order TTL is a bug on this venue.**
It only looks correct while you are testing against one long-lived market.

## One more reason a pool address is not a window

The indexer returns **114 different markets sharing the single pool address** the agent had rolled
onto. DreamDEX recycles pool contracts across windows continuously, which is why redemption is
keyed by market id and never by pool, and why an agent has to carry the window's expiry itself
rather than ask the pool what it is trading.
