import { ethers } from "hardhat";

async function main() {
  const [signer] = await ethers.getSigners();
  const addr = await signer.getAddress();
  const bal = await ethers.provider.getBalance(addr);
  const net = await ethers.provider.getNetwork();
  console.log("chainId :", net.chainId.toString());
  console.log("signer  :", addr);
  console.log("balance :", ethers.formatEther(bal), "STT");
}
main().catch((e) => { console.error(e); process.exit(1); });
