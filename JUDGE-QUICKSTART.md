# Judge quickstart

Five minutes, no signup, no API key, no wallet needed for the read-only path.

The single claim this project makes is: **the agent trades with nothing running off-chain.**
Everything below exists to let you check that yourself rather than take our word for it.

---

## 1. The claim, in one command (30 seconds, no install)

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

**If it returns a subscription id**, the chain is holding a standing instruction to call our
contract, and no server of ours is involved. Look it up:

```bash
curl -s -X POST https://dream-rpc.somnia.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"somnia_reactivityGetSubscriptionInfo","params":["SUB_ID_HEX"]}'
```

Check three fields:

| Field | Expected | Why it matters |
|---|---|---|
| `handler_contract_address` | `0x7668a2effa84eB34d90b1611F867c706904687Df` | the chain calls our agent |
| `handler_function_selector` | `0x53edf33d` | that is `onEvent(address,bytes32[],bytes)` |
| `emitter` | `0x3ecC694Cef705358864a646142ac17A90E29e388` | DreamDEX BinaryMarketsModule |

**If it returns `[]`, that is expected and not a failure.** An armed subscription burns about
4.2 STT a day at the rate DreamDEX delivers events, and the chain enforces a 32 STT floor under
the owner, so it is armed in sessions rather than left on. The measurements are in
`SPIKE-FINDINGS.md`. Step 2 is the permanent record, and it lives in contract state, not in a
database of ours.

---

## 2. What the agent has actually done (60 seconds)

```bash
git clone https://github.com/Risingtell/vane.git
cd vane/sdk && npm install ethers
node cli.js status --agent 0x7668a2effa84eB34d90b1611F867c706904687Df
```

Expected output, read live from the chain:

```
agent            0x7668a2effa84eB34d90b1611F867c706904687Df
owner            0x5018Ce8efCA43Ca361Cc413d3b63d9ACF8726053
operator         0x5018Ce8efCA43Ca361Cc413d3b63d9ACF8726053
tradingEnabled   true
activePool       0x54D90260Fe949940A80602E7fDa8ebD729c5BE00
maxPerWindow     10.0
reserve          250.0
freeCollateral   300.0
wakeCount        28
tradeCount       9
reclaimCount     2
redeemCount      1
trackedOrders    0
```

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
  -d '{"query":"query { Order(where: {owner: {_eq: \"0x7668a2effa84eb34d90b1611f867c706904687df\"}}) { orderId status price fullQuantity rested } }"}'
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

Expect **55 passing**. The tests are named after the claims they defend. The ones worth
reading first:

- `lets only the owner withdraw`
- `withdraws even while trading is live, which is the point of the design`
- `never lets the operator move collateral out`
- `refuses to be woken by anyone other than the precompile`
- `is permissionless, so funds are not stranded if the operator vanishes`
- `does NOT forget orders when nothing had expired yet`
- `claims BOTH sides of a voided market`
- `reclaims and redeems instead of trading` (the scheduled housekeeping wake)

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
