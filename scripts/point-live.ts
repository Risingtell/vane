import { ethers } from "hardhat";

const INDEXER = "https://dev.smk.somnia.host/v1/graphql";

/// Point an agent at the DreamDEX window that is open right now.
///
/// A subscription wakes the agent on events from BinaryMarketsModule, and the module is the
/// emitter, not the pool, so the handler always falls back to `activePool`. Windows roll every
/// few hours, so an agent left pointed at yesterday's pool wakes correctly and then has every
/// order rejected by a closed book. This is the roll-forward step, and it is owner-only because
/// it grants the pool an allowance.
///
///   AGENT_ADDR=0x... npx hardhat run scripts/point-live.ts --network shannon
async function main() {
  const agentAddr = process.env.AGENT_ADDR;
  if (!agentAddr) throw new Error("set AGENT_ADDR");

  const [signer] = await ethers.getSigners();
  const agent = await ethers.getContractAt("VaneAgent", agentAddr, signer);

  // Require at least an hour left, so orders can rest their full 300s and then be reclaimed
  // rather than dying with the window.
  const now = Math.floor(Date.now() / 1000);
  const res = await fetch(INDEXER, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `query { Market(where: {marketType: {_eq: BINARY}, clobStatus: {_eq: Trading},
        expiry: {_gt: "${now + 3600}"}, question: {_ilike: "%opening price%"}},
        order_by: {expiry: asc}, limit: 1) { poolAddress question expiry } }`,
    }),
  });
  const j: any = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  const mkt = j.data.Market[0];
  if (!mkt) throw new Error("no window open with enough time left; try again shortly");

  const pool = ethers.getAddress(mkt.poolAddress);
  const current = await agent.activePool();
  console.log("window  :", mkt.question);
  console.log("pool    :", pool, "expires", new Date(Number(mkt.expiry) * 1000).toISOString());
  if (current === pool) {
    console.log("already pointed here, nothing to do");
    return;
  }

  await (await agent.setPoolAllowed(pool, true)).wait();
  await (await agent.setActivePool(pool)).wait();
  console.log("was     :", current);
  console.log("now     :", await agent.activePool());
  console.log("\nArm it with: npx hardhat run scripts/arm-agent.ts --network shannon");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
