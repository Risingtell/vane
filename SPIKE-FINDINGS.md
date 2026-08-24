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
