import { ethers } from "hardhat";

/// Deploys the spike and funds it. The contract subscribes on its own behalf, so the
/// contract (not the deployer) is the subscription owner and pays for every wake.
async function main() {
  const [signer] = await ethers.getSigners();
  const addr = await signer.getAddress();
  const bal = await ethers.provider.getBalance(addr);
  console.log("deployer :", addr);
  console.log("balance  :", ethers.formatEther(bal), "STT");

  const fund = ethers.parseEther(process.env.FUND_STT ?? "1");
  if (bal <= fund) {
    throw new Error(`deployer has ${ethers.formatEther(bal)} STT, needs more than ${ethers.formatEther(fund)}`);
  }

  const factory = await ethers.getContractFactory("ReactivityPing");
  const ping = await factory.deploy({ value: fund });
  await ping.waitForDeployment();
  const pingAddr = await ping.getAddress();

  console.log("ReactivityPing:", pingAddr);
  console.log("funded with   :", ethers.formatEther(fund), "STT");
  console.log("explorer      : https://shannon-explorer.somnia.network/address/" + pingAddr);
  console.log("\nSave it:  export PING_ADDR=" + pingAddr);
}

main().catch((e) => { console.error(e); process.exit(1); });
