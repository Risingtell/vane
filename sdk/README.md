# vane-agent

Run an on-chain trading agent for DreamDEX event contracts on Somnia. No server, no bot process
and no keeper: the chain itself wakes the agent.

```bash
npm install vane-agent ethers
```

`ethers` v6 is a peer dependency. Node 20 or newer.

## CLI

```bash
npx vane markets                          # windows open right now
npx vane status --agent 0x..              # everything an agent has done
npx vane subs   --owner 0x..              # what the node is holding for an account

npx vane faucet                           # claim 10,000 test tUSDC
npx vane create --factory 0x..            # deploy your own agent
npx vane fund   --agent 0x.. --amount 100

npx vane arm    --agent 0x.. --topic 0x.. # hand it to the chain
npx vane disarm                           # take it back, and stop spending STT

npx vane reclaim --agent 0x.. --pool 0x..
npx vane sweep   --agent 0x.. --market-id 0x.. --market 0x..
```

Reads need nothing. Writes need `PRIVATE_KEY` in the environment, and it should be a throwaway
testnet key.

## Library

```js
import { status, subscriptions, arm, disarm, liveMarkets } from "vane-agent";

// What the NODE is holding. This is the proof nothing local is running.
const ids = await subscriptions("0xYourOperator");

// Everything the agent has done, from contract state.
const s = await status("0xYourAgent");
console.log(s.wakeCount, s.tradeCount, s.reclaimCount, s.redeemCount);

// Windows open right now, soonest to settle first.
const markets = await liveMarkets({ limit: 5 });
```

## Two numbers that will cost you an afternoon otherwise

**A subscription owner must hold at least 32 STT.** The floor is enforced by the chain, and below
it `subscribe` reverts with **empty revert data**, so there is nothing to decode and nothing in
any error message that points at a balance. `arm()` checks this before spending gas and tells you
plainly.

**Arm with at least 8,000,000 gas.** Placing one binary order measured about 3.95M gas and grows
with how many book levels the order walks. Too low a `gasLimit` does not surface as an
out-of-gas anywhere: the handler still runs, the inner pool call fails, and the agent logs an
ordinary rejected order. `DEFAULT_WAKE_GAS` is 8M for this reason.

## Why the signer owns the subscription, not the agent

`subscribe` records `msg.sender` as the owner, but `unsubscribe` authorises on `tx.origin`. A
contract that owns its own subscription therefore **cannot cancel it from a user transaction**,
because `tx.origin` will be the user. Putting ownership on an ordinary account keeps a real kill
switch, and it also means the agent contract never has to hold STT.

## Licence

MIT.
