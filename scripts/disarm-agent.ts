import { ethers } from "hardhat";

const PRECOMPILE = "0x0000000000000000000000000000000000000100";

/// Cancel every reactivity subscription this EOA owns.
/// Works because the signer is the subscription owner, so tx.origin matches, which is
/// exactly the condition a contract-owned subscription cannot satisfy.
async function main() {
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  const ids: string[] = await ethers.provider.send("somnia_reactivityGetSubscriptions", [me]);
  if (!ids.length) {
    console.log("no subscriptions to cancel");
    return;
  }
  const precompile = await ethers.getContractAt(["function unsubscribe(uint256)"], PRECOMPILE, signer);
  for (const id of ids) {
    const rc = await (await precompile.unsubscribe(BigInt(id), { gasLimit: 500_000 })).wait();
    console.log("cancelled", BigInt(id).toString(), "tx", rc?.hash);
  }
  const left: string[] = await ethers.provider.send("somnia_reactivityGetSubscriptions", [me]);
  console.log("remaining:", left.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
