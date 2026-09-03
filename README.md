# Vane

[![CI](https://github.com/Risingtell/vane/actions/workflows/ci.yml/badge.svg)](https://github.com/Risingtell/vane/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**A prediction-market trading agent with no server, no bot process and no keeper.**
It lives on-chain as a Solidity contract, and the Somnia chain itself wakes it to trade
DreamDEX event contracts, reclaim its escrow and redeem what it wins.

Built for the Somnia x DreamDEX Event Contracts Hackathon.

| | |
|---|---|
| **Live console** | https://vane-console.vercel.app |
| **Demo video** | (added at submission) |
| **Network** | Somnia Shannon testnet, chain 50312 |
| **Agent** | [`0x8779a3987637Ba5DE3E802D6BBA7F7dD5cd9c92B`](https://shannon-explorer.somnia.network/address/0x8779a3987637Ba5DE3E802D6BBA7F7dD5cd9c92B) |
| **Factory** | [`0x5CBe8710c2cFf0E8CeFdAb7e5080F4B5faF7De5D`](https://shannon-explorer.somnia.network/address/0x5CBe8710c2cFf0E8CeFdAb7e5080F4B5faF7De5D) |
| **Tests** | `77` passing, contracts and TypeScript both clean |
| **SDK / CLI** | `sdk/`, an ESM SDK plus a `vane` command |

Every number above can be re-derived by anyone, from the chain, in one command:

```bash
git clone https://github.com/Risingtell/vane.git
cd vane/sdk && npm install ethers
node cli.js status --agent 0x8779a3987637Ba5DE3E802D6BBA7F7dD5cd9c92B
```

## Why this is not another trading bot

DreamDEX ships [`dreamdex-bot-kit`](https://github.com/somnia-chain/dreamdex-bot-kit) with six
working event-contract strategies and a set of AI agent skills. Anyone can fork it and have an
off-chain bot trading in an afternoon, so an off-chain bot is not an entry, it is the baseline.

Vane is the thing that kit cannot produce: **there is no process to run.** Somnia can store an
event subscription in chain state and invoke a contract when a matching log is committed. Vane
registers itself with that precompile and is then driven entirely by the chain. Turn off every
machine involved and it keeps trading.

Put another way: **Vane is not a bot that automates event contracts, it is an event-contract-native
agent.** Somnia reactivity calls the Solidity contract directly, and the contract chooses the next
window, trades it, reclaims its escrow and redeems what settles. Most ways of automating this
still depend on something that keeps running, a delegated key, or a wallet the user has to sign
with when a window rolls. Vane removes that layer rather than hiding it.

## Verify it yourself in about sixty seconds

Ask the node what it is holding. If the chain has a subscription naming the agent as its
handler, then nothing of ours needs to be running for the agent to act:

```bash
curl -s -X POST https://dream-rpc.somnia.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"somnia_reactivityGetSubscriptions","params":["0x5018Ce8efCA43Ca361Cc413d3b63d9ACF8726053"]}'
```

Then read what it has done, straight from contract state:

```bash
git clone https://github.com/Risingtell/vane.git
cd vane/sdk && npm install ethers
node cli.js status --agent 0x8779a3987637Ba5DE3E802D6BBA7F7dD5cd9c92B
```

`JUDGE-QUICKSTART.md` is the five-minute version, with the exact output to expect at each step.

## What it does, mapped to the platform

| Vane does this | Using this Somnia or DreamDEX capability |
|---|---|
| Is woken by the chain, with nothing running off-chain | Reactivity precompile `0x0100`, `subscribe` with a Solidity handler |
| Moves itself onto each new window as it opens | A second subscription on DreamDEX's `MarketCreated`, decoded in the handler |
| Runs housekeeping on a timer without a cron | `scheduleAtTimestamp`, matched on the `Schedule(uint256)` topic |
| Trades binary up/down windows | `BinaryPool.placeBinaryOrder`, on the on-chain CLOB |
| Builds inventory with no counterparty | `mintSet`, complete sets of YES and NO |
| Frees collateral stuck in dead orders | `cancelExpiredOrders`, permissionless on a binary pool |
| Turns settled positions back into collateral | `BinaryMarketsModule.redeem`, keyed by market id |
| Reads the winning side of a settled market | `payoutNumerators()` argmax, honouring `isVoided()` |
| Holds positions | `OutcomeToken6909`, the shared ERC-6909 singleton |
| Finds live windows and its own order history | The Somnia Markets indexer (GraphQL) |
| Lets anyone self-onboard | The tUSDC `faucet(uint256)` on testnet |

## How it works

**1. A subscription is stored in chain state.** The owner registers a filter on DreamDEX market
events with the reactivity precompile at `0x0100`, naming the agent contract as the handler and
`onEvent(address,bytes32[],bytes)` as the entry point.

**2. The chain calls the agent.** When a matching log lands, the node invokes the handler. The
call arrives with `msg.sender` set to the precompile, which is the only caller the contract will
accept.

**3. It trades inside a policy it cannot exceed.** A per-window budget, a reserve it will never
spend, a cooldown, an allowlist of pools, and a quantity rounded down onto the venue lot grid.
All enforced on-chain before an order goes out.

**4. It moves itself onto the next window.** A second subscription wakes it on DreamDEX's
`MarketCreated`. The new pool arrives as an indexed topic, and the venue, collateral and expiry
sit in fixed slots at the head of the event data, so the agent judges a window and takes it
without any off-chain help. It holds a book until under ten minutes are left, then takes the next
one the venue opens.

**5. It gets the money back.** A scheduled one-shot wake, told apart from a market wake by its
topic, releases escrow from expired orders and redeems anything that settled. Escrow is tracked
against the pool it was placed in, so moving on never strands it.

## Why this matters to DreamDEX

- **More trading activity.** An agent can act on any event the venue emits, at any hour, without
  anyone being awake or any process being up.
- **More builder surface.** The reactivity integration, the event decoding and the window
  selection are a reusable pattern for any reactive event-contract app, not just this one. The
  SDK and CLI are in `sdk/`, and `SPIKE-FINDINGS.md` and `FEEDBACK-REPORT.md` exist so the next
  builder does not pay the same costs.
- **Better retention.** A user sets a policy once and the chain executes it. There is no session
  to keep alive and nothing to log back into.
- **Safer automation.** One agent per user from a factory, owner-only and unconditional
  withdrawal, an operator that can trade and can never move funds, and reclaim and redeem that
  anyone can trigger so nothing is stranded if the operator disappears.
- **The honest limit.** Always-on operation needs a funded subscription owner, because arming
  burns STT against a chain-enforced floor. That is a cost question for the ecosystem, not a
  missing feature. The measurements are in `SPIKE-FINDINGS.md`.

This is a claim about the execution model, not about the strategy. The strategy shipped here is
deliberately simple and makes no claim to make money.

## Custody, stated plainly

DreamDEX gives a third party no way to trade event contracts for someone else. Both routes are
closed, and both were checked against live Shannon rather than assumed:

- The operator permission registry is spot only. A BinaryPool escrows through the module and has
  no operator gate.
- `placeBinaryOrderFor(owner, ...)` reverts `OnlyApprovedContracts()` for anyone outside the
  protocol allowlist, whatever owner is passed.
- Plain `placeBinaryOrder` pulls collateral from `msg.sender`.

So whoever trades has to hold the money. Rather than dress that up, Vane holds the collateral and
removes the danger instead:

- **One agent per user.** A factory deploys a separate contract per owner, so no collateral is
  ever pooled with anyone else's.
- **`withdraw` is owner-only and unconditional.** It does not depend on the strategy, the
  operator, the pause flag or the chain subscription. If every other part of this breaks, the
  money still comes out.
- **The operator may trade and nothing else.** It can never move collateral.
- **Reclaim and redeem are permissionless.** If the operator disappears, any passer-by can still
  free the owner's collateral and claim their winnings, and both land in the agent.
- **Collateral never pays gas.** Reactivity bills the subscription owner, which is the operator's
  own account, so the agent holds no STT at all.

## Quickstart

Requires Node 20 or newer. No API key and no signup.

```bash
git clone https://github.com/Risingtell/vane.git
cd vane
npm install
npx hardhat compile
npx hardhat test
```

On Windows, if PowerShell refuses to run `npm`, that is the default execution policy blocking
`npm.ps1` rather than anything in this repo. Use `npm.cmd` and `npx.cmd`, or run it from Git Bash.

To run an agent of your own on Shannon:

```bash
cd sdk && npm link            # provides the `vane` command
export PRIVATE_KEY=0x...      # a throwaway testnet key, never one holding real funds
vane faucet                   # 10,000 test tUSDC
vane create --factory 0x5CBe8710c2cFf0E8CeFdAb7e5080F4B5faF7De5D
vane fund   --agent 0x... --amount 100
```

Then hand it to the chain. `arm` stores two standing instructions: wake me when this market
moves, and wake me when a new window opens.

```bash
vane arm    --agent 0x...     # both topics
vane status --agent 0x...
vane disarm                   # stops it, and stops spending STT
```

A fresh agent has no window yet and stands down with `no active pool set` until the venue opens
one, which is at most a few minutes. To give it a book to trade immediately instead:

```bash
cd ..                         # back to the repo root
AGENT_ADDR=0x... npx hardhat run scripts/point-live.ts --network shannon
```

That is a convenience, not a requirement. The agent replaces whatever it is given at the first
window it likes better.

## Reproduce the whole story

One command runs the entire lifecycle against live Shannon: deploy, be woken by the chain and
trade, reclaim the escrow those orders held, take a position in a settling window, then redeem it
once the oracle resolves.

```bash
PRIVATE_KEY=0x... npx hardhat run scripts/demo-run.ts --network shannon
```

It takes roughly twenty-five minutes, most of it waiting for a real window to settle.

## Tech

Solidity 0.8.25 on Hardhat, TypeScript scripts, ethers v6, a dependency-free static console, and
an ESM SDK with a CLI. Contract interfaces were derived from the shipped
`@somnia-chain/markets-sdk` ABIs and then checked against live Shannon, not written from prose.

## What is honestly not production grade

- **The strategy is deliberately simple.** A single sized order per window at a configured price.
  The point of this project is the execution model, not alpha, and the judge-facing claim is not
  that it makes money.
- **Testnet only.** Somnia documents the reactivity RPC methods as testnet only, so an agent of
  this design cannot run on mainnet today.
- **Custodial by necessity, not by choice.** See the custody section. The mitigations are real
  and tested, but the collateral does sit in a contract.
- **Arming costs STT continuously, and that is the real limit on this design.** With both
  subscriptions live the agent is woken about 4 times a minute at roughly 0.002 STT a wake, which
  measured out at **8 to 25 STT a day** depending on how much of that is trading rather than
  standing down. With a chain-enforced 32 STT floor under the subscription owner, a 45 STT balance
  buys well under a day of continuous arming, and a Shannon faucet grant is about 1 STT. So the
  subscription is armed in sessions rather than left on, and the console will often show no live
  subscription while still showing everything the agent did while it was armed. Keeping one armed
  indefinitely is a funding problem, not a code one.
- **Roughly half of the venue's window-opening events never reach a subscriber.** Measured at
  52% delivery over 13 minutes of blocks, with the drops concentrated in large batch
  transactions. The agent is built around that rather than against it: it accepts the frequent
  short windows rather than holding out for a rare long one, so a missed event costs minutes, not
  the session. Full measurement in `SPIKE-FINDINGS.md`.
- **Positions are valued at book cost.** There is no mark-to-market of an open position.
- **Order ids are tracked for one book at a time.** If the agent moves to a new window while
  orders it placed are still tracked against the previous one, orders on the new book are not
  added to the reclaim list until the old ones clear. In the shipped configuration this is close
  to moot, because the default order type is immediate-or-cancel and an unfilled remainder is
  cancelled rather than left resting, so there is no escrow to chase. It would matter to anyone
  who reconfigures the agent to rest limit orders.
- **Positions are not rolled between markets.** The agent moves itself onto the next window, but
  it does not carry an open position across; it reclaims and starts fresh.

## Notes for other builders

`FEEDBACK-REPORT.md` is the optional SDK and documentation feedback the submission guidelines
ask for: six things that cost real building time on live Shannon, each with the measurement and a
suggested fix, plus the one thing about the platform that is genuinely good.

### The findings themselves


`SPIKE-FINDINGS.md` documents everything learned against live Shannon, including six things that
cost real time and are not in the docs: a chain-enforced 32 STT minimum on a subscription owner
that reverts with no reason data, `unsubscribe` authorising on `tx.origin` while `subscribe`
records `msg.sender`, a venue lot grid that rejects off-grid quantities, and a subscription gas
limit that silently turns a trade into an ordinary rejected order, an `eth_getLogs` range capped
at 1000 blocks on a chain that makes ten blocks a second, and what an armed subscription actually
costs per day.

## Licence

MIT.
