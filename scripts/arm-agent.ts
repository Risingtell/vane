import { ethers } from "hardhat";

const PRECOMPILE = "0x0000000000000000000000000000000000000100";
const BINARY_MARKETS_MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";

/// A DreamDEX market wake. This is the one the agent trades on.
const TOPIC_MARKET = "0x4ca9766196d8679d9b2e01457f67073d844b29646ce302169de44cd72e593d11";
/// MarketCreated. This is the one that lets the agent move itself onto the next window.
const TOPIC_MARKET_CREATED = "0xb5ec75cdb7dbcd28a5f50d152d8833334525a902ef5332ebc19bcf5c0011f8cd";

/// Subscribe the chain to wake a VaneAgent on DreamDEX market events.
///
/// The SIGNER owns the subscription, not the agent. That is deliberate, and it comes
/// out of the day-one spike: `subscribe` records msg.sender as owner, but `unsubscribe`
/// authorises on tx.origin, so a contract that owns its own subscription can never
/// cancel it from a user transaction. An EOA-owned subscription keeps a real kill
/// switch, and it also means the agent contract never has to hold STT.
///
/// The owner must hold at least 32 STT: that floor is enforced by the chain, and it
/// reverts with no reason data when unmet.
async function main() {
  const agentAddr = process.env.AGENT_ADDR;
  if (!agentAddr) throw new Error("set AGENT_ADDR");
  // Two standing instructions by default, because the agent needs two different things
  // from the chain: tell me when this market moves, and tell me when a new one opens.
  // Armed on the first alone it trades whatever window it was last pointed at by hand,
  // and keeps trading it long after that book has closed.
  const topics: [string, string][] = process.env.TOPIC0
    ? [["market", process.env.TOPIC0]]
    : [["market", TOPIC_MARKET], ["new windows", TOPIC_MARKET_CREATED]];

  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();
  const balance = await ethers.provider.getBalance(me);
  console.log("subscription owner:", me, ethers.formatEther(balance), "STT");
  if (balance < ethers.parseEther("32")) {
    throw new Error("owner needs at least 32 STT; the chain rejects the subscription below that");
  }

  const precompile = await ethers.getContractAt(
    [
      "function subscribe((bytes32[4],address,address,address,address,bytes4,uint64,uint64,uint64,bool,bool)) returns (uint256)",
      "function unsubscribe(uint256)",
    ],
    PRECOMPILE,
    signer,
  );

  for (const [label, topic0] of topics) {
    const sub = [
      [topic0, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash], // topic filter
      ethers.ZeroAddress, // origin: any
      ethers.ZeroAddress, // caller: reserved
      BINARY_MARKETS_MODULE, // emitter
      agentAddr, // handler
      "0x53edf33d", // onEvent(address,bytes32[],bytes)
      ethers.parseUnits("1", "gwei"), // priority fee
      ethers.parseUnits("50", "gwei"), // max fee
      // Placing one binary order measured ~3.95M gas on a live pool, and the cost grows
      // with how many book levels the order walks. Too small a limit does NOT surface as
      // an out-of-gas: the handler's inner call simply fails and the agent logs a rejected
      // order. Leave generous headroom. The protocol cap is 200,000,000.
      8_000_000n, // gas limit per wake
      false,
      false,
    ];

    const tx = await precompile.subscribe(sub, { gasLimit: 1_000_000 });
    const rc = await tx.wait();
    console.log("armed on", label + ":", topic0, "tx", rc?.hash);
  }

  const ids: string[] = await ethers.provider.send("somnia_reactivityGetSubscriptions", [me]);
  console.log("subscriptions owned by this EOA:", ids.map((i) => BigInt(i).toString()).join(", "));
  console.log("\nThe chain will now wake", agentAddr, "on every matching market event.");
  console.log("Stop it with: npx hardhat run scripts/disarm-agent.ts --network shannon");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
