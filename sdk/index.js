// Vane SDK: run your own on-chain trading agent on Somnia.
//
// Everything here talks to contracts and to the node directly. There is no Vane server,
// because there is no Vane server anywhere in the design.

import { Contract, JsonRpcProvider, Interface, parseUnits, formatUnits, ZeroAddress, ZeroHash } from "ethers";

/** Somnia Shannon testnet. Reactivity is testnet only, so this is where agents run. */
export const SHANNON = {
  chainId: 50312,
  rpc: "https://dream-rpc.somnia.network",
  explorer: "https://shannon-explorer.somnia.network",
  indexer: "https://dev.smk.somnia.host/v1/graphql",
  /** tUSDC, 6 decimals. Mainnet USDso is 18, so never hardcode the scale. */
  collateral: "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E",
  binaryMarketsModule: "0x3ecC694Cef705358864a646142ac17A90E29e388",
  reactivity: "0x0000000000000000000000000000000000000100",
};

/** onEvent(address,bytes32[],bytes). The selector the reactivity precompile calls. */
export const ON_EVENT_SELECTOR = "0x53edf33d";

/** topic0 of Schedule(uint256), which a one-shot scheduleAtTimestamp fires. */
export const TOPIC_SCHEDULE = "0x67aa3d752967d87d8944b9c7adf73172518777fa4703f336edee81f0736d8987";

/**
 * topic0 of a DreamDEX market wake. Emitted by BinaryMarketsModule as windows trade.
 * This is the one the agent trades on.
 */
export const TOPIC_MARKET = "0x4ca9766196d8679d9b2e01457f67073d844b29646ce302169de44cd72e593d11";

/**
 * topic0 of MarketCreated, emitted when DreamDEX opens a new window. This is the one that
 * lets the agent move itself onto the next market, so nothing has to point it by hand.
 *
 * Recovered by hashing the event signatures in @somnia-chain/markets-sdk against live
 * module logs: the module's implementation is unverified on the explorer and the signature
 * is in no public topic database.
 */
export const TOPIC_MARKET_CREATED = "0xb5ec75cdb7dbcd28a5f50d152d8833334525a902ef5332ebc19bcf5c0011f8cd";

/**
 * The DreamDEX venue on Shannon.
 *
 * ⚠ This is the ONLY field that separates real DreamDEX windows from the "Pricefeed test"
 * markets the same module creates, in the same bursts, in the same transactions. Both are
 * marketType BINARY with the same tUSDC collateral. DreamDEX is operatorId 2, the
 * throwaway pricefeed markets are operatorId 4.
 */
export const DREAMDEX_VENUE_ID = "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c";

/**
 * The chain enforces a minimum balance on a subscription owner, and rejects with EMPTY
 * revert data below it, which is close to undiagnosable. Measured on Shannon: 31 fails,
 * 32 passes.
 */
export const MIN_OWNER_STT = 32n;

/**
 * Placing one binary order measured ~3.95M gas, and it grows with how many book levels the
 * order walks. Too low a subscription gasLimit does NOT surface as out-of-gas: the handler
 * still runs, the inner pool call fails, and it looks like an ordinary rejected order.
 */
export const DEFAULT_WAKE_GAS = 8_000_000n;

export const AGENT_ABI = [
  "function owner() view returns (address)",
  "function operator() view returns (address)",
  "function collateral() view returns (address)",
  "function tradingEnabled() view returns (bool)",
  "function activePool() view returns (address)",
  "function activePoolExpiry() view returns (uint64)",
  "function rollVenueId() view returns (bytes32)",
  "function minWindowSeconds() view returns (uint64)",
  "function orderPool() view returns (address)",
  "function maxPerWindow() view returns (uint256)",
  "function reserve() view returns (uint256)",
  "function lotSize() view returns (uint256)",
  "function wakeCount() view returns (uint256)",
  "function tradeCount() view returns (uint256)",
  "function reclaimCount() view returns (uint256)",
  "function redeemCount() view returns (uint256)",
  "function rollCount() view returns (uint256)",
  "function openOrderCount() view returns (uint256)",
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function emergencyExit()",
  "function setOperator(address next)",
  "function setTradingEnabled(bool enabled)",
  "function setPolicy(uint256 maxPerWindow, uint256 reserve, uint64 minSecondsBetweenTrades)",
  "function setStrategy(uint256 limitPrice, uint8 orderType)",
  "function setPoolAllowed(address pool, bool allowed)",
  "function setActivePool(address pool)",
  "function setRollForward(bytes32 venueId, uint64 minWindowSeconds)",
  "function setPendingMarket(bytes32 marketId, address market)",
  "function mintPositions(address pool, uint256 amount)",
  "function poke(address pool)",
  "function reclaimExpired(address pool)",
  "function sweepSettled(bytes32 marketId, address market)",
  "function housekeep()",
];

export const FACTORY_ABI = [
  "function createAgent() returns (address)",
  "function agentOf(address) view returns (address)",
  "function agentCount() view returns (uint256)",
  "function collateral() view returns (address)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function faucet(uint256 amount)",
];

const REACTIVITY_ABI = [
  "function subscribe((bytes32[4],address,address,address,address,bytes4,uint64,uint64,uint64,bool,bool)) returns (uint256)",
  "function unsubscribe(uint256)",
];

let _provider = null;

export function provider(rpc = SHANNON.rpc) {
  if (!_provider) _provider = new JsonRpcProvider(rpc);
  return _provider;
}

/**
 * Release the RPC connection so a script can end on its own.
 * A provider keeps a poller alive, and forcing exit around it trips an intermittent libuv
 * assertion on Windows that looks exactly like a crash to anyone reading the output.
 */
export function close() {
  if (_provider) {
    _provider.destroy();
    _provider = null;
  }
}

/** Claim test collateral. tUSDC carries its own faucet, so nobody has to be asked. */
export async function faucet(signer, amount = "10000") {
  const t = new Contract(SHANNON.collateral, ERC20_ABI, signer);
  const tx = await t.faucet(parseUnits(amount, 6));
  return tx.wait();
}

/** Create the caller's agent. One per address, so a second call reverts rather than orphaning the first. */
export async function createAgent(signer, factoryAddress) {
  const f = new Contract(factoryAddress, FACTORY_ABI, signer);
  await (await f.createAgent()).wait();
  return f.agentOf(await signer.getAddress());
}

export async function fund(signer, agentAddress, amount) {
  const t = new Contract(SHANNON.collateral, ERC20_ABI, signer);
  const value = parseUnits(String(amount), 6);
  await (await t.approve(agentAddress, value)).wait();
  const a = new Contract(agentAddress, AGENT_ABI, signer);
  return (await a.deposit(value)).wait();
}

/** Everything the console shows, in one read. */
export async function status(agentAddress, rpc = SHANNON.rpc) {
  const p = provider(rpc);
  const a = new Contract(agentAddress, AGENT_ABI, p);
  const t = new Contract(SHANNON.collateral, ERC20_ABI, p);
  const [owner, operator, trading, pool, expiry, venue, minWindow, orderPool,
    maxW, reserve, wakes, trades, reclaims, redeems, rolls, open, bal] =
    await Promise.all([
      a.owner(), a.operator(), a.tradingEnabled(), a.activePool(), a.activePoolExpiry(),
      a.rollVenueId(), a.minWindowSeconds(), a.orderPool(), a.maxPerWindow(), a.reserve(),
      a.wakeCount(), a.tradeCount(), a.reclaimCount(), a.redeemCount(), a.rollCount(),
      a.openOrderCount(), t.balanceOf(agentAddress),
    ]);
  const secondsLeft = expiry === 0n ? null : Number(expiry) - Math.floor(Date.now() / 1000);
  return {
    agent: agentAddress, owner, operator, tradingEnabled: trading, activePool: pool,
    // Set only when the agent moved itself here, since that is the path that learns it.
    activePoolExpiry: expiry === 0n ? null : Number(expiry),
    windowSecondsLeft: secondsLeft,
    rollsForward: venue !== ZeroHash,
    rollVenueId: venue, minWindowSeconds: Number(minWindow),
    // The book the tracked orders are resting in, which is not always the active one.
    orderPool,
    maxPerWindow: formatUnits(maxW, 6), reserve: formatUnits(reserve, 6),
    freeCollateral: formatUnits(bal, 6),
    wakeCount: wakes.toString(), tradeCount: trades.toString(),
    reclaimCount: reclaims.toString(), redeemCount: redeems.toString(),
    rollCount: rolls.toString(),
    trackedOrders: open.toString(),
  };
}

/**
 * Hand the agent to the chain: store a subscription that wakes it on DreamDEX market events.
 *
 * The SIGNER owns the subscription, not the agent, and that is deliberate. `subscribe`
 * records msg.sender as owner but `unsubscribe` authorises on tx.origin, so a contract that
 * owns its own subscription can never cancel it from a user transaction. An EOA-owned
 * subscription keeps a real kill switch and means the agent holds no STT at all.
 */
export async function arm(signer, agentAddress, { topic0, emitter = SHANNON.binaryMarketsModule,
  gasLimit = DEFAULT_WAKE_GAS, priorityFeeGwei = 1n, maxFeeGwei = 50n } = {}) {
  if (!topic0) throw new Error("topic0 is required: the market event to wake on");
  const bal = await signer.provider.getBalance(await signer.getAddress());
  if (bal < MIN_OWNER_STT * 10n ** 18n) {
    throw new Error(`subscription owner needs at least ${MIN_OWNER_STT} STT; the chain rejects it below that, with no revert reason`);
  }
  const r = new Contract(SHANNON.reactivity, REACTIVITY_ABI, signer);
  const tx = await r.subscribe([
    [topic0, ZeroHash, ZeroHash, ZeroHash],
    ZeroAddress, ZeroAddress, emitter, agentAddress, ON_EVENT_SELECTOR,
    priorityFeeGwei * 10n ** 9n, maxFeeGwei * 10n ** 9n, gasLimit, false, false,
  ], { gasLimit: 1_000_000 });
  await tx.wait();
  return subscriptions(await signer.getAddress(), signer.provider);
}

/** Cancel every subscription this account owns. Works because tx.origin is the owner. */
export async function disarm(signer) {
  const me = await signer.getAddress();
  const ids = await signer.provider.send("somnia_reactivityGetSubscriptions", [me]);
  const r = new Contract(SHANNON.reactivity, REACTIVITY_ABI, signer);
  for (const id of ids) await (await r.unsubscribe(BigInt(id), { gasLimit: 500_000 })).wait();
  return ids.map((i) => BigInt(i).toString());
}

/** Ask the NODE what it is holding. This is the proof nothing local is running. */
export async function subscriptions(owner, p = provider()) {
  const ids = await p.send("somnia_reactivityGetSubscriptions", [owner]);
  return ids.map((i) => BigInt(i).toString());
}

export async function subscriptionInfo(id, p = provider()) {
  const info = await p.send("somnia_reactivityGetSubscriptionInfo", [
    "0x" + BigInt(id).toString(16),
  ]);
  return Array.isArray(info) ? info[0] : info;
}

/** Release escrow held by expired orders. Permissionless: anyone may call it. */
export async function reclaim(signer, agentAddress, pool) {
  const a = new Contract(agentAddress, AGENT_ABI, signer);
  return (await a.reclaimExpired(pool, { gasLimit: 8_000_000 })).wait();
}

/** Turn a settled position back into collateral. Permissionless: anyone may call it. */
export async function sweep(signer, agentAddress, marketId, market) {
  const a = new Contract(agentAddress, AGENT_ABI, signer);
  return (await a.sweepSettled(marketId, market, { gasLimit: 8_000_000 })).wait();
}

/** Windows currently open for trading, soonest to settle first. */
export async function liveMarkets({ limit = 5, indexer = SHANNON.indexer } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const query = `query { Market(where: {marketType: {_eq: BINARY}, clobStatus: {_eq: Trading},
    expiry: {_gt: "${now}"}, question: {_ilike: "%opening price%"}},
    order_by: {expiry: asc}, limit: ${limit})
    { marketId poolAddress marketAddress question expiry intervalSec lastPrice } }`;
  const res = await fetch(indexer, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }),
  });
  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data.Market;
}

export const agentInterface = new Interface(AGENT_ABI);
