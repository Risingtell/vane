# Judge quickstart

Five minutes, no signup, no API key, no wallet needed for the read-only path.

The single claim this project makes is: **the agent trades with nothing running off-chain.**
Everything below exists to let you check that yourself rather than take our word for it.

---

## 1. Is it armed right now? (30 seconds, no install)

> **An empty result here is not the failure condition.** Step 1 answers "is it armed today".
> Step 2 answers "has the chain ever driven it", which is the permanent record and the actual
> claim. If step 1 comes back empty, keep going.


Two ways to check it, and they answer different questions. **Is it armed right now?** is a
question about today. **Did the chain ever drive it?** is a permanent record in contract state,
and that one is answerable whether or not a subscription happens to be armed while you look.

Start with the live one. Ask the Somnia node what subscriptions it is holding for the operator
account:

```bash
curl -s -X POST https://dream-rpc.somnia.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"somnia_reactivityGetSubscriptions","params":["0x5018Ce8efCA43Ca361Cc413d3b63d9ACF8726053"]}'
```

**If it returns subscription ids**, the chain is holding standing instructions to call our
contract, and no server of ours is involved. There are normally two: one wakes the agent on
market activity so it can trade, and one wakes it when DreamDEX opens a new window so it can move
itself onto it. Look either up:

```bash
curl -s -X POST https://dream-rpc.somnia.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"somnia_reactivityGetSubscriptionInfo","params":["SUB_ID_HEX"]}'
```

Check three fields:

| Field | Expected | Why it matters |
|---|---|---|
| `handler_contract_address` | `0x8779a3987637Ba5DE3E802D6BBA7F7dD5cd9c92B` | the chain calls our agent |
| `handler_function_selector` | `0x53edf33d` | that is `onEvent(address,bytes32[],bytes)` |
| `emitter` | `0x3ecC694Cef705358864a646142ac17A90E29e388` | DreamDEX BinaryMarketsModule |

**If it returns `[]`, that is expected and not a failure.** Two armed subscriptions burn 8 to 25
STT a day at the rate DreamDEX delivers events, and the chain enforces a 32 STT floor under the
owner, so they are armed in sessions rather than left on. The measurements are in
`SPIKE-FINDINGS.md`. Step 2 is the permanent record, and it lives in contract state, not in a
database of ours.

---

## 2. What the agent has actually done (60 seconds)

```bash
git clone https://github.com/Risingtell/vane.git
cd vane/sdk && npm install ethers
node cli.js status --agent 0x8779a3987637Ba5DE3E802D6BBA7F7dD5cd9c92B
```

Expected output. This is a real capture, and **the counters only ever go up**, so the numbers you
see will be equal or higher. Nothing here can be reset or faked:

```
agent            0x8779a3987637Ba5DE3E802D6BBA7F7dD5cd9c92B
owner            0x5018Ce8efCA43Ca361Cc413d3b63d9ACF8726053
operator         0x5018Ce8efCA43Ca361Cc413d3b63d9ACF8726053
tradingEnabled   true
activePool       0x2AA87ab604568374Bbe98CaF308273cc0Dd7085a
activePoolExpiry 1788427200
windowSecondsLeft -6394
windowState      ended, the agent takes a new window on its next armed session
rollsForward     true
rollVenueId      0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c
minWindowSeconds 240
orderPool        0x246a65643ad8b6C6Dbd0b017A259DA07681242FD
maxPerWindow     10.0
reserve          50.0
freeCollateral   203.960776
wakeCount        52
tradeCount       14
reclaimCount     0
redeemCount      0
rollCount        2
trackedOrders    4
```

**`rollCount` is the one to look at.** It counts windows the agent picked out of a `MarketCreated`
event and moved onto by itself. Nobody chose those pools.

Two readings that are **not** failures, and are the two most likely to mislead you:

- **`windowSecondsLeft` is negative.** That means the last armed session ended and the window the
  agent was on has since closed. `windowState` says so in words. It takes a new window on its next
  armed session; it does not need fixing.
- **`trackedOrders` is not zero while `reclaimCount` is zero.** Escrow is released by a scheduled
  housekeeping wake or by anyone calling `reclaimExpired`, and the default order type is
  immediate-or-cancel, so an unfilled remainder is cancelled by the venue rather than left
  resting. The filled portion is a position, not stranded money.

| Field | Means |
|---|---|
| `wakeCount` | times the chain called the contract |
| `tradeCount` | orders placed on the DreamDEX book |
| `reclaimCount` | times it freed escrow from expired orders |
| `redeemCount` | settled positions turned back into collateral |
| `trackedOrders` | orders still holding escrow; zero means nothing is stranded |

These counters only ever go up, so treat the numbers above as a floor rather than an exact
match. They were read from the chain on 27 Aug 2026.

`wakeCount` is the number that matters. It only increments inside `onEvent`, and `onEvent`
reverts unless `msg.sender` is the reactivity precompile at `0x0100`. Nothing else can raise it,
which is why it is proof of the claim even when nothing is armed today.

---

## 3. See the orders on DreamDEX itself (30 seconds)

Independent of our contract, straight from the Somnia Markets indexer:

```bash
curl -s -X POST https://dev.smk.somnia.host/v1/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"query { Order(where: {owner: {_eq: \"0x8779a3987637ba5de3e802d6bba7f7dd5cd9c92b\"}}) { orderId status price fullQuantity rested } }"}'
```

These are real orders resting on a real order book, owned by the agent contract.

---

## 4. Click it (no install)

**https://vane-console.vercel.app**

The console reads the same node and the same indexer you just queried. It shows whether a
subscription is armed, what the agent has done, the current market window, and its activity: the
agent's own events while they are still within reach of the node, and its permanent order history
from the DreamDEX indexer once they are not.

There is a **Get test tUSDC** button that calls the tUSDC faucet directly, so you can fund an
agent of your own without asking anyone for tokens.

---

## 5. Run the tests (2 minutes)

```bash
cd vane
npm install
npx hardhat test
```

Expect **75 passing**. The tests are named after the claims they defend. The ones worth
reading first:

- `lets only the owner withdraw`
- `withdraws even while trading is live, which is the point of the design`
- `never lets the operator move collateral out`
- `refuses to be woken by anyone other than the precompile`
- `is permissionless, so funds are not stranded if the operator vanishes`
- `claims BOTH sides of a voided market`
- `reclaims and redeems instead of trading` (the scheduled housekeeping wake)

And, for the part that moves it between windows on its own:

- `moves onto a window the chain has just opened, with nobody in the loop`
- `ignores the pricefeed test markets, which differ ONLY by venue`
- `stays put while its own window is open, however long the new one is`
- `clamps its order to the end of the window it just moved onto`
- `would be rejected by the venue without that clamp` (so the test above cannot pass vacuously)
- `still reclaims from the OLD book after moving on`

**If you are on Windows and PowerShell refuses to run `npm`**, that is the default execution
policy blocking `npm.ps1`, not a problem with this repo. Use `npm.cmd install` and
`npx.cmd hardhat test`, or run the commands from Git Bash.

---

## 6. Reproduce the whole lifecycle yourself (about 25 minutes)

If you want to watch it happen from scratch rather than inspect ours:

```bash
cd vane
npm install
export PRIVATE_KEY=0x...   # a throwaway Shannon key
npx hardhat run scripts/demo-run.ts --network shannon
```

It deploys a fresh agent, funds it, hands it to the chain, waits to be woken and trade, disarms,
reclaims the escrow those orders held, takes a position in a settling window, waits for the
oracle, and redeems. Most of the elapsed time is waiting for a real market window to close.

You will need Shannon STT. The subscription owner must hold **at least 32 STT**: that floor is
enforced by the chain and it rejects with no revert reason at all when unmet, which is documented
in `SPIKE-FINDINGS.md` along with the other three traps that cost us real time.

---

## What we would look at if we were reviewing this

- `contracts/VaneAgent.sol`. `_onEvent` is the whole idea. Note it never reverts on a business
  condition, because a revert would roll back the wake and erase the evidence the chain called.
- `contracts/interfaces/SomniaEventHandler.sol`, the handler base and the subscription encoding,
  including the detail that a scheduled time is a **topic filter in milliseconds**, not a
  parameter.
- `SPIKE-FINDINGS.md`, what the platform actually does versus what its docs say.
