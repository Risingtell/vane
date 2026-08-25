import { ethers } from "hardhat";

const TUSDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
const INDEXER = "https://dev.smk.somnia.host/v1/graphql";

async function gql(query: string): Promise<any> {
  const res = await fetch(INDEXER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const json: any = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

/// Prove the whole loop on live Shannon: take a position, let the window settle, then turn
/// the settled position back into collateral with nobody watching.
///
/// A complete set is used rather than a trade because these short windows have empty books,
/// so a crossing order has nothing to fill against. Minting needs no counterparty and is how
/// a maker builds inventory. One side pays 1 and the other 0, so the set is worth its cost.
async function main() {
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();

  const tusdc = await ethers.getContractAt(
    [
      "function approve(address,uint256) returns (bool)",
      "function balanceOf(address) view returns (uint256)",
    ],
    TUSDC,
    signer,
  );

  // A window closing soon, so settlement lands inside this run.
  const now = Math.floor(Date.now() / 1000);
  const data = await gql(`query { Market(where: {marketType: {_eq: BINARY}, clobStatus: {_eq: Trading},
      expiry: {_gt: "${now + 40}"}}, order_by: {expiry: asc}, limit: 1)
      { marketId poolAddress marketAddress question expiry } }`);
  const m = data.Market[0];
  if (!m) throw new Error("no market is trading with a future expiry");
  const pool = ethers.getAddress(m.poolAddress);
  const market = ethers.getAddress(m.marketAddress);
  console.log("market  :", m.question);
  console.log("pool    :", pool);
  console.log("settles in", Number(m.expiry) - now, "s");

  const factory = await (await ethers.getContractFactory("VaneFactory")).deploy(TUSDC, me);
  await factory.waitForDeployment();
  await (await factory.createAgent()).wait();
  const agentAddr = await factory.agentOf(me);
  const agent = await ethers.getContractAt("VaneAgent", agentAddr, signer);
  console.log("agent   :", agentAddr);

  const stake = ethers.parseUnits("20", 6);
  await (await tusdc.approve(agentAddr, stake)).wait();
  await (await agent.deposit(stake)).wait();
  await (await agent.setPoolAllowed(pool, true)).wait();
  await (await agent.setActivePool(pool)).wait();
  await (await agent.setPendingMarket(m.marketId, market)).wait();

  const before = await tusdc.balanceOf(agentAddr);
  console.log("deposited:", ethers.formatUnits(before, 6), "tUSDC");

  const mintAmount = ethers.parseUnits("10", 6);
  await (await agent.mintPositions(pool, mintAmount, { gasLimit: 6_000_000 })).wait();
  const afterMint = await tusdc.balanceOf(agentAddr);
  console.log("after mint:", ethers.formatUnits(afterMint, 6), "tUSDC  (spent", ethers.formatUnits(before - afterMint, 6) + ")");

  const marketRead = await ethers.getContractAt(
    [
      "function isResolved() view returns (bool)",
      "function isVoided() view returns (bool)",
      "function outcomeToken() view returns (address)",
      "function yesId() view returns (uint256)",
      "function noId() view returns (uint256)",
    ],
    market,
  );
  const outcomeToken = await marketRead.outcomeToken();
  const yesId = await marketRead.yesId();
  const noId = await marketRead.noId();
  const outcome = await ethers.getContractAt(
    ["function balanceOf(address,uint256) view returns (uint256)"],
    outcomeToken,
  );
  console.log("position  : YES", (await outcome.balanceOf(agentAddr, yesId)).toString(),
    "NO", (await outcome.balanceOf(agentAddr, noId)).toString());

  // Wait for the oracle to settle the window. Resolution is permissionless and automatic.
  console.log("\nwaiting for settlement...");
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    const resolved = await marketRead.isResolved();
    const voided = await marketRead.isVoided();
    if (resolved || voided) {
      console.log("settled:", resolved ? "resolved" : "voided");
      break;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  if (!(await marketRead.isResolved()) && !(await marketRead.isVoided())) {
    console.log("still not settled; re-run the sweep later with scripts/sweep-live.ts");
    console.log("export AGENT_ADDR=" + agentAddr);
    console.log("export MARKET_ID=" + m.marketId);
    console.log("export MARKET_ADDR=" + market);
    return;
  }

  const beforeSweep = await tusdc.balanceOf(agentAddr);
  const rc = await (await agent.sweepSettled(m.marketId, market, { gasLimit: 8_000_000 })).wait();
  for (const log of rc!.logs) {
    try {
      const d = agent.interface.parseLog(log as any);
      if (d) console.log("  ", d.name, "->", d.args.map(String).join(" | "));
    } catch {}
  }
  const afterSweep = await tusdc.balanceOf(agentAddr);
  console.log("redeemed  :", ethers.formatUnits(afterSweep - beforeSweep, 6), "tUSDC back");
  console.log("agent now :", ethers.formatUnits(afterSweep, 6), "tUSDC");
  console.log("redeemCount:", (await agent.redeemCount()).toString());
  console.log("\nexport AGENT_ADDR=" + agentAddr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
