# Judge quickstart

Five minutes, no signup, no API key, no wallet needed for the read-only path.

The single claim this project makes is: **the agent trades with nothing running off-chain.**
Everything below exists to let you check that yourself rather than take our word for it.

---

## 1. The claim, in one command (30 seconds, no install)

Ask the Somnia node what subscriptions it is holding for the operator account:

```bash
curl -s -X POST https://dream-rpc.somnia.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"somnia_reactivityGetSubscriptions","params":["VANE_OPERATOR"]}'
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
| `handler_contract_address` | `VANE_AGENT` | the chain calls our agent |
| `handler_function_selector` | `0x53edf33d` | that is `onEvent(address,bytes32[],bytes)` |
| `emitter` | `0x3ecC694Cef705358864a646142ac17A90E29e388` | DreamDEX BinaryMarketsModule |

**If it returns `[]`, that is expected and not a failure.** Each wake costs STT, so the
subscription is switched off between sessions. Step 2 shows what it did while it was armed, and
that record lives in contract state, not in a database of ours.

---

## 2. What the agent has actually done (60 seconds)

```bash
git clone https://github.com/Risingtell/vane.git
cd vane/sdk && npm install ethers
node cli.js status --agent VANE_AGENT
```

Expected output, read live from the chain:

```
agent            VANE_AGENT
owner            VANE_OPERATOR
tradingEnabled   ...
wakeCount        VANE_WAKES     <- times the chain called the contract
tradeCount       VANE_TRADES    <- orders placed on the DreamDEX book
reclaimCount     VANE_RECLAIMS  <- times it freed escrow from expired orders
redeemCount      VANE_REDEEMS   <- settled positions turned back into collateral
freeCollateral   ...
```

`wakeCount` is the number that matters. It only increments inside `onEvent`, and `onEvent`
reverts unless `msg.sender` is the reactivity precompile at `0x0100`. Nothing else can raise it.

---

## 3. See the orders on DreamDEX itself (30 seconds)

Independent of our contract, straight from the Somnia Markets indexer:

```bash
curl -s -X POST https://dev.smk.somnia.host/v1/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"query { Order(where: {owner: {_eq: \"VANE_AGENT_LOWER\"}}) { orderId status price fullQuantity rested } }"}'
```

These are real orders resting on a real order book, owned by the agent contract.

---

## 4. Click it (no install)

**https://vane-console.vercel.app**

The console reads the same node and the same indexer you just queried. It shows the live
subscription, what the agent has done, the current market window, and its on-chain event feed.

There is a **Get test tUSDC** button that calls the tUSDC faucet directly, so you can fund an
agent of your own without asking anyone for tokens.

---

## 5. Run the tests (2 minutes)

```bash
cd vane
npm install
npx hardhat test
```

Expect **VANE_TESTS passing**. The tests are named after the claims they defend. The ones worth
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

- `contracts/VaneAgent.sol` — `_onEvent` is the whole idea. Note it never reverts on a business
  condition, because a revert would roll back the wake and erase the evidence the chain called.
- `contracts/interfaces/SomniaEventHandler.sol` — the handler base and the subscription encoding,
  including the detail that a scheduled time is a **topic filter in milliseconds**, not a
  parameter.
- `SPIKE-FINDINGS.md` — what the platform actually does versus what its docs say.
