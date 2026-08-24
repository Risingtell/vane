import { ethers } from "hardhat";

const TUSDC = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
const INDEXER = "https://dev.smk.somnia.host/v1/graphql";

/// Pools are recycled every window, so never hardcode one. Ask the indexer which
/// binary market is trading right now and has room left before it expires.
async function liveBinaryPool(): Promise<{ pool: string; question: string; expiry: number }> {
  const body = JSON.stringify({
    query: `query { Market(where: {marketType: {_eq: BINARY}, clobStatus: {_eq: Trading}},
             order_by: {expiry: desc}, limit: 20)
             { poolAddress question expiry intervalSec } }`,
  });
  const res = await fetch(INDEXER, { method: "POST", headers: { "content-type": "application/json" }, body });
  const json: any = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  const now = Math.floor(Date.now() / 1000);
  // Skip windows about to close, so the order has time to rest.
  const usable = (json.data.Market as any[]).filter((m) => Number(m.expiry) - now > 300);
  if (!usable.length) throw new Error("no binary market is trading with enough time left");
  const m = usable[0];
  return { pool: ethers.getAddress(m.poolAddress), question: m.question, expiry: Number(m.expiry) };
}

async function main() {
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  console.log("signer:", me);

  const tusdc = await ethers.getContractAt(
    ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
    TUSDC,
    signer,
  );
  console.log("tUSDC :", ethers.formatUnits(await tusdc.balanceOf(me), 6));

  // The operator defaults to this signer: it may trade, and can never withdraw.
  const factory = await (await ethers.getContractFactory("VaneFactory")).deploy(TUSDC, me);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("VaneFactory:", factoryAddr);

  await (await factory.createAgent()).wait();
  const agentAddr = await factory.agentOf(me);
  console.log("VaneAgent  :", agentAddr);

  const agent = await ethers.getContractAt("VaneAgent", agentAddr, signer);

  const deposit = ethers.parseUnits(process.env.DEPOSIT ?? "100", 6);
  await (await tusdc.approve(agentAddr, deposit)).wait();
  await (await agent.deposit(deposit)).wait();
  console.log("deposited  :", ethers.formatUnits(deposit, 6), "tUSDC");

  const { pool, question, expiry } = await liveBinaryPool();
  console.log("live market:", question);
  console.log("pool       :", pool, "expires in", expiry - Math.floor(Date.now() / 1000), "s");

  await (await agent.setPoolAllowed(pool, true)).wait();
  await (await agent.setActivePool(pool)).wait();
  // Commit at most 10 tUSDC per window, always keep 50 back, no cooldown for the demo.
  await (await agent.setPolicy(ethers.parseUnits("10", 6), ethers.parseUnits("50", 6), 0)).wait();
  await (await agent.setTradingEnabled(true)).wait();
  console.log("armed: maxPerWindow 10, reserve 50");

  console.log("\nexport FACTORY_ADDR=" + factoryAddr);
  console.log("export AGENT_ADDR=" + agentAddr);
  console.log("export POOL_ADDR=" + pool);
  console.log("explorer: https://shannon-explorer.somnia.network/address/" + agentAddr);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
