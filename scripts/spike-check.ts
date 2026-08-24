import { ethers } from "hardhat";

/// The proof step. Reads how many times the chain woke the contract, and confirms the
/// subscription is registered on the node itself. Run this with everything else stopped.
async function main() {
  const pingAddr = process.env.PING_ADDR;
  if (!pingAddr) throw new Error("set PING_ADDR to the deployed spike address");

  const ping = await ethers.getContractAt("ReactivityPing", pingAddr);
  const bal = await ethers.provider.getBalance(pingAddr);

  console.log("contract        :", pingAddr);
  console.log("balance         :", ethers.formatEther(bal), "STT");
  console.log("running         :", await ping.running());
  console.log("wakeCount       :", (await ping.wakeCount()).toString());
  console.log("lastWakeBlock   :", (await ping.lastWakeBlock()).toString());
  console.log("lastWakeTime    :", new Date(Number(await ping.lastWakeTimestamp()) * 1000).toISOString());
  console.log("timerSubId      :", (await ping.currentSubscriptionId()).toString());
  console.log("eventSubId      :", (await ping.eventSubscriptionId()).toString());
  console.log("nextWakeAtMillis:", (await ping.nextWakeAtMillis()).toString());

  // Ask the node directly, so this does not rely on our own contract's bookkeeping.
  const res = await ethers.provider.send("somnia_reactivityGetSubscriptions", [pingAddr]);
  console.log("\nsubscriptions the node has registered for this contract:", Array.isArray(res) ? res.length : res);
  if (Array.isArray(res)) {
    for (const s of res) {
      console.log("  id", s.id, "handler", s.handler_contract_address, "selector", s.handler_function_selector);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
