import { ethers } from "hardhat";

/// Arms the spike. MODE=timer schedules a one-shot wake that re-arms itself.
/// MODE=event arms a persistent subscription that re-fires on every matching log.
async function main() {
  const pingAddr = process.env.PING_ADDR;
  if (!pingAddr) throw new Error("set PING_ADDR to the deployed spike address");

  const ping = await ethers.getContractAt("ReactivityPing", pingAddr);
  const mode = process.env.MODE ?? "timer";

  if (mode === "timer") {
    const delay = Number(process.env.DELAY_SECONDS ?? "30");
    const tx = await ping.start(delay);
    const rc = await tx.wait();
    console.log("armed timer, delay", delay, "s  tx:", rc?.hash);
    console.log("subscriptionId   :", (await ping.currentSubscriptionId()).toString());
    console.log("nextWakeAtMillis :", (await ping.nextWakeAtMillis()).toString());
  } else {
    // Default emitter is DreamDEX's BinaryMarketsModule, the contract that announces
    // every new event-contract window. Topic 0 means "any event from it".
    const emitter = process.env.EMITTER ?? "0x3ecC694Cef705358864a646142ac17A90E29e388";
    const topic0 = process.env.TOPIC0 ?? ethers.ZeroHash;
    const tx = await ping.armOnEvent(emitter, topic0);
    const rc = await tx.wait();
    console.log("armed on event from", emitter, "topic0", topic0, " tx:", rc?.hash);
    console.log("eventSubscriptionId:", (await ping.eventSubscriptionId()).toString());
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
