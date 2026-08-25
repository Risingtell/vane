import { ethers } from "hardhat";

const TUSDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";

/// Wait for the agent's pending market to settle, then turn the position back into
/// collateral. Split out from demo-run so a settlement can be finished later, or by
/// somebody else entirely: sweepSettled is permissionless and always credits the agent.
///
///   AGENT_ADDR=0x... npx hardhat run scripts/sweep-live.ts --network shannon
async function main() {
  const agentAddr = process.env.AGENT_ADDR;
  if (!agentAddr) throw new Error("set AGENT_ADDR");

  const [signer] = await ethers.getSigners();
  const agent = await ethers.getContractAt("VaneAgent", agentAddr, signer);
  const tusdc = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)"], TUSDC,
  );

  const marketId = process.env.MARKET_ID ?? (await agent.pendingMarketId());
  const market = process.env.MARKET_ADDR ?? (await agent.pendingMarket());
  if (market === ethers.ZeroAddress) throw new Error("no pending market on this agent");
  console.log("market", market, marketId);

  const m = await ethers.getContractAt(
    [
      "function isResolved() view returns (bool)",
      "function isVoided() view returns (bool)",
      "function outcomeToken() view returns (address)",
      "function yesId() view returns (uint256)",
      "function noId() view returns (uint256)",
    ],
    market,
  );

  // Resolution is oracle driven and permissionless, so this is only waiting on the chain.
  const deadline = Date.now() + Number(process.env.WAIT_MINUTES ?? "30") * 60_000;
  while (Date.now() < deadline) {
    if ((await m.isResolved()) || (await m.isVoided())) break;
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 15_000));
  }
  console.log("");

  const resolved = await m.isResolved();
  const voided = await m.isVoided();
  if (!resolved && !voided) {
    console.log("still not settled. Re-run later; the position keeps until it is claimed.");
    return;
  }
  console.log("settled:", resolved ? "resolved" : "voided");

  const before = await tusdc.balanceOf(agentAddr);
  const rc = await (await agent.sweepSettled(marketId, market, { gasLimit: 8_000_000 })).wait();
  for (const l of rc!.logs) {
    try {
      const d = agent.interface.parseLog(l as any);
      if (d) console.log("  ", d.name, "->", d.args.map(String).join(" | "));
    } catch {}
  }
  const after = await tusdc.balanceOf(agentAddr);
  console.log("redeemed  :", ethers.formatUnits(after - before, 6), "tUSDC");
  console.log("free now  :", ethers.formatUnits(after, 6), "tUSDC");
  console.log("redeemCount:", (await agent.redeemCount()).toString());
}

main().catch((e) => { console.error(e); process.exit(1); });
