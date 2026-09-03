# vane-agent

Run an on-chain trading agent for DreamDEX event contracts on Somnia. No server, no bot process
and no keeper: the chain itself wakes the agent.

```bash
git clone https://github.com/Risingtell/vane.git
cd vane/sdk && npm install ethers
```

`ethers` v6 is a peer dependency. Node 20 or newer.

## CLI

```bash
node cli.js markets                          # windows open right now
node cli.js status --agent 0x..              # everything an agent has done
node cli.js subs   --owner 0x..              # what the node is holding for an account

node cli.js faucet                           # claim 10,000 test tUSDC
node cli.js create --factory 0x..            # deploy your own agent
node cli.js fund   --agent 0x.. --amount 100

node cli.js arm    --agent 0x..              # hand it to the chain (both topics)
node cli.js disarm                           # take it back, and stop spending STT

node cli.js reclaim --agent 0x.. --pool 0x..
node cli.js sweep   --agent 0x.. --market-id 0x.. --market 0x..
```

Reads need nothing. Writes need `PRIVATE_KEY` in the environment, and it should be a throwaway
testnet key.

## Library

```js
import { status, subscriptions, arm, disarm, liveMarkets } from "./index.js";

// What the NODE is holding. This is the proof nothing local is running.
const ids = await subscriptions("0xYourOperator");

// Everything the agent has done, from contract state.
const s = await status("0xYourAgent");
console.log(s.wakeCount, s.tradeCount, s.reclaimCount, s.redeemCount);

// Windows open right now, soonest to settle first.
const markets = await liveMarkets({ limit: 5 });

// Windows the agent chose for itself, and where that left it.
console.log(s.rollCount, s.activePool, s.windowSecondsLeft);
```

## Three numbers that will cost you an afternoon otherwise

**A flat order lifetime is a bug on this venue.** An order may not outlive the market it trades:
the pool reverts `OrderExpiryBeyondMarket()` (selector `0xd3dea628`) with no reason string. It
will not show up while you test against one long-lived window, and then every order fails the
moment your agent starts moving between five-minute ones. Clamp the order expiry to the window.

**A subscription owner must hold at least 32 STT.** The floor is enforced by the chain, and below
it `subscribe` reverts with **empty revert data**, so there is nothing to decode and nothing in
any error message that points at a balance. `arm()` checks this before spending gas and tells you
plainly.

**Arm with at least 8,000,000 gas.** Placing one binary order measured about 3.95M gas and grows
with how many book levels the order walks. Too low a `gasLimit` does not surface as an
out-of-gas anywhere: the handler still runs, the inner pool call fails, and the agent logs an
ordinary rejected order. `DEFAULT_WAKE_GAS` is 8M for this reason.

## Moving onto new windows

`arm()` with no `topic0` registers two subscriptions: one on DreamDEX market activity, and one on
`MarketCreated`. The second is what lets an agent move itself onto the next window instead of
waiting to be pointed at one. `TOPIC_MARKET`, `TOPIC_MARKET_CREATED` and `DREAMDEX_VENUE_ID` are
exported for anyone doing this by hand.

⚠ **Do not treat a subscription as a reliable queue.** Measured on Shannon, only about **52%** of
matching logs produce a wake at all, with the drops clustered in large batch transactions. Build
for a wake that may simply never arrive.

## Why the signer owns the subscription, not the agent

`subscribe` records `msg.sender` as the owner, but `unsubscribe` authorises on `tx.origin`. A
contract that owns its own subscription therefore **cannot cancel it from a user transaction**,
because `tx.origin` will be the user. Putting ownership on an ordinary account keeps a real kill
switch, and it also means the agent contract never has to hold STT.

## Licence

MIT.
