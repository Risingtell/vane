import { ethers } from "hardhat";

const TUSDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
const INDEXER = "https://dev.smk.somnia.host/v1/graphql";
const PRECOMPILE = "0x0000000000000000000000000000000000000100";
const BINARY_MARKETS_MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";
// One of the topics BinaryMarketsModule emits as windows roll over.
const MARKET_TOPIC = "0x4ca9766196d8679d9b2e01457f67073d844b29646ce302169de44cd72e593d11";

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gql(query: string): Promise<any> {
  const res = await fetch(INDEXER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const j: any = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

/// Runs the entire Vane story against live Shannon, in order:
/// deploy, be woken by the chain and trade, reclaim the escrow those orders held,
/// take a position in a settling window, then redeem it once the oracle resolves.
async function main() {
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  const tusdc = await ethers.getContractAt(
    ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
    TUSDC,
    signer,
  );
  log("operator", me, ethers.formatEther(await ethers.provider.getBalance(me)), "STT");

  // ---------------------------------------------------------------- 1. deploy
  const factory = await (await ethers.getContractFactory("VaneFactory")).deploy(TUSDC, me);
  await factory.waitForDeployment();
  await (await factory.createAgent()).wait();
  const agentAddr = await factory.agentOf(me);
  const agent = await ethers.getContractAt("VaneAgent", agentAddr, signer);
  log("factory", await factory.getAddress());
  log("agent  ", agentAddr);

  const deposit = ethers.parseUnits(process.env.DEPOSIT ?? "300", 6);
  await (await tusdc.approve(agentAddr, deposit)).wait();
  await (await agent.deposit(deposit)).wait();

  // A window with room left, so orders have time to rest before it rolls.
  const now = Math.floor(Date.now() / 1000);
  const tradeMkt = (await gql(`query { Market(where: {marketType: {_eq: BINARY}, clobStatus: {_eq: Trading},
    expiry: {_gt: "${now + 900}"}, question: {_ilike: "%opening price%"}},
    order_by: {expiry: asc}, limit: 1) { poolAddress question } }`)).Market[0];
  const tradePool = ethers.getAddress(tradeMkt.poolAddress);
  log("trading", tradeMkt.question, "on", tradePool);

  await (await agent.setPoolAllowed(tradePool, true)).wait();
  await (await agent.setActivePool(tradePool)).wait();
  // LIMIT below the market so orders REST. That is what leaves escrow to reclaim, which a
  // crossing order would never demonstrate.
  await (await agent.setStrategy(ethers.parseUnits("0.45", 6), 0)).wait();
  await (await agent.setPolicy(ethers.parseUnits("10", 6), ethers.parseUnits("250", 6), 60)).wait();
  // Trading is OFF until the owner turns it on. Without this every wake stands down with
  // "trading disabled", which looks exactly like the chain never called at all.
  await (await agent.setTradingEnabled(true)).wait();

  // ------------------------------------------------- 2. let the chain drive it
  const precompile = await ethers.getContractAt(
    [
      "function subscribe((bytes32[4],address,address,address,address,bytes4,uint64,uint64,uint64,bool,bool)) returns (uint256)",
      "function unsubscribe(uint256)",
    ],
    PRECOMPILE,
    signer,
  );
  await (await precompile.subscribe(
    [
      [MARKET_TOPIC, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash],
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      BINARY_MARKETS_MODULE,
      agentAddr,
      "0x53edf33d", // onEvent(address,bytes32[],bytes)
      ethers.parseUnits("1", "gwei"),
      ethers.parseUnits("50", "gwei"),
      8_000_000n, // below ~4M the pool call runs out of gas and looks like a rejected order
      false,
      false,
    ],
    { gasLimit: 1_000_000 },
  )).wait();
  const subs: string[] = await ethers.provider.send("somnia_reactivityGetSubscriptions", [me]);
  log("armed subscription", subs.map((s) => BigInt(s).toString()).join(","));

  const wantTrades = 3n;
  const until = Date.now() + 6 * 60 * 1000;
  while (Date.now() < until) {
    const [w, t] = [await agent.wakeCount(), await agent.tradeCount()];
    log("wakes", w.toString(), "trades", t.toString());
    if (t >= wantTrades) break;
    await sleep(15_000);
  }

  for (const id of await ethers.provider.send("somnia_reactivityGetSubscriptions", [me])) {
    await (await precompile.unsubscribe(BigInt(id), { gasLimit: 500_000 })).wait();
  }
  log("disarmed, so it stops spending STT");

  // ------------------------------------------------------ 3. reclaim the escrow
  // Orders carry a 300s expiry and the pool only releases them once past it.
  log("waiting for the resting orders to expire...");
  await sleep(320_000);
  const beforeReclaim = await tusdc.balanceOf(agentAddr);
  const rc = await (await agent.reclaimExpired(tradePool, { gasLimit: 8_000_000 })).wait();
  for (const l of rc!.logs) {
    try { const d = agent.interface.parseLog(l as any); if (d) log("  ", d.name, d.args.map(String).join(" | ")); } catch {}
  }
  log("reclaimed", ethers.formatUnits((await tusdc.balanceOf(agentAddr)) - beforeReclaim, 6), "tUSDC");

  // --------------------------------------------- 4. take a position and redeem
  const now2 = Math.floor(Date.now() / 1000);
  const settleMkt = (await gql(`query { Market(where: {marketType: {_eq: BINARY}, clobStatus: {_eq: Trading},
    expiry: {_gt: "${now2 + 90}"}, question: {_ilike: "%opening price%"}},
    order_by: {expiry: asc}, limit: 1) { marketId poolAddress marketAddress question expiry } }`)).Market[0];
  const settlePool = ethers.getAddress(settleMkt.poolAddress);
  const settleMarket = ethers.getAddress(settleMkt.marketAddress);
  log("settling window:", settleMkt.question, "in", Number(settleMkt.expiry) - now2, "s");

  await (await agent.setPoolAllowed(settlePool, true)).wait();
  await (await agent.setPendingMarket(settleMkt.marketId, settleMarket)).wait();
  // A complete set needs no counterparty, which matters because these books are often empty.
  await (await agent.mintPositions(settlePool, ethers.parseUnits("10", 6), { gasLimit: 6_000_000 })).wait();
  log("minted a complete set");

  const marketRead = await ethers.getContractAt(
    ["function isResolved() view returns (bool)", "function isVoided() view returns (bool)"],
    settleMarket,
  );
  const settleBy = Date.now() + 25 * 60 * 1000;
  while (Date.now() < settleBy) {
    if ((await marketRead.isResolved()) || (await marketRead.isVoided())) break;
    await sleep(20_000);
  }
  log("settled:", (await marketRead.isResolved()) ? "resolved" : (await marketRead.isVoided()) ? "voided" : "NOT YET");

  const beforeSweep = await tusdc.balanceOf(agentAddr);
  const sc = await (await agent.sweepSettled(settleMkt.marketId, settleMarket, { gasLimit: 8_000_000 })).wait();
  for (const l of sc!.logs) {
    try { const d = agent.interface.parseLog(l as any); if (d) log("  ", d.name, d.args.map(String).join(" | ")); } catch {}
  }
  log("redeemed", ethers.formatUnits((await tusdc.balanceOf(agentAddr)) - beforeSweep, 6), "tUSDC");

  // ------------------------------------------------------------------- summary
  console.log("\n=============== VANE DEMO COMPLETE ===============");
  console.log("agent          ", agentAddr);
  console.log("factory        ", await factory.getAddress());
  console.log("woken by chain ", (await agent.wakeCount()).toString());
  console.log("orders placed  ", (await agent.tradeCount()).toString());
  console.log("escrow reclaims", (await agent.reclaimCount()).toString());
  console.log("redemptions    ", (await agent.redeemCount()).toString());
  console.log("free collateral", ethers.formatUnits(await tusdc.balanceOf(agentAddr), 6), "tUSDC");
  console.log("\nweb/config.js:");
  console.log(`window.VANE_AGENT="${agentAddr}";`);
  console.log(`window.VANE_FACTORY="${await factory.getAddress()}";`);
  console.log(`window.VANE_OPERATOR="${me}";`);
}

main().catch((e) => { console.error(e); process.exit(1); });
