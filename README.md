# Vane

**A prediction-market trading agent with no server, no bot process and no keeper.**
It lives on-chain as a Solidity contract, and the Somnia chain itself wakes it to trade
DreamDEX event contracts, reclaim its escrow and redeem what it wins.

Built for the Somnia x DreamDEX Event Contracts Hackathon.

| | |
|---|---|
| **Live console** | https://vane-console.vercel.app |
| **Demo video** | (added at submission) |
| **Network** | Somnia Shannon testnet, chain 50312 |
| **Agent** | [`VANE_AGENT`](https://shannon-explorer.somnia.network) |
| **Factory** | [`VANE_FACTORY`](https://shannon-explorer.somnia.network) |
| **Tests** | `VANE_TESTS` passing, contracts and TypeScript both clean |
| **SDK / CLI** | `sdk/`, published as `vane-agent` |

Every number above can be re-derived by anyone, from the chain, in one command:

```bash
npx vane status --agent VANE_AGENT
```

## Why this is not another trading bot

DreamDEX ships [`dreamdex-bot-kit`](https://github.com/somnia-chain/dreamdex-bot-kit) with six
working event-contract strategies and a set of AI agent skills. Anyone can fork it and have an
off-chain bot trading in an afternoon, so an off-chain bot is not an entry, it is the baseline.

Vane is the thing that kit cannot produce: **there is no process to run.** Somnia can store an
event subscription in chain state and invoke a contract when a matching log is committed. Vane
registers itself with that precompile and is then driven entirely by the chain. Turn off every
machine involved and it keeps trading.

## Verify it yourself in about sixty seconds

Ask the node what it is holding. If the chain has a subscription naming the agent as its
handler, then nothing of ours needs to be running for the agent to act:

```bash
curl -s -X POST https://dream-rpc.somnia.network \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"somnia_reactivityGetSubscriptions","params":["VANE_OPERATOR"]}'
```

Then read what it has done, straight from contract state:

```bash
npx vane status --agent VANE_AGENT
```

`JUDGE-QUICKSTART.md` is the five-minute version, with the exact output to expect at each step.

## What it does, mapped to the platform

| Vane does this | Using this Somnia or DreamDEX capability |
|---|---|
| Is woken by the chain, with nothing running off-chain | Reactivity precompile `0x0100`, `subscribe` with a Solidity handler |
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

**4. It gets the money back.** A scheduled one-shot wake, told apart from a market wake by its
topic, releases escrow from expired orders and redeems anything that settled.

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

To run an agent of your own on Shannon:

```bash
cd sdk && npm link            # provides the `vane` command
export PRIVATE_KEY=0x...      # a throwaway testnet key, never one holding real funds
vane faucet                   # 10,000 test tUSDC
vane create --factory VANE_FACTORY
vane fund   --agent 0x... --amount 100
vane arm    --agent 0x... --topic 0x4ca9766196d8679d9b2e01457f67073d844b29646ce302169de44cd72e593d11
vane status --agent 0x...
vane disarm                   # stops it, and stops spending STT
```

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
- **Arming costs STT continuously.** Around 0.00093 STT per wake. The subscription is switched
  off between sessions, so the console will often show no live subscription while still showing
  everything the agent did while armed.
- **Positions are valued at book cost.** There is no mark-to-market of an open position.

## Notes for other builders

`SPIKE-FINDINGS.md` documents everything learned against live Shannon, including four things that
cost real time and are not in the docs: a chain-enforced 32 STT minimum on a subscription owner
that reverts with no reason data, `unsubscribe` authorising on `tx.origin` while `subscribe`
records `msg.sender`, a venue lot grid that rejects off-grid quantities, and a subscription gas
limit that silently turns a trade into an ordinary rejected order.

## Licence

MIT.
