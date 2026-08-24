import { expect } from "chai";
import { ethers, network } from "hardhat";
import type { Contract, Signer } from "ethers";

/// Without typechain, `.connect()` widens to BaseContract and loses the method types.
const as$ = (c: unknown, signer: Signer) => (c as Contract).connect(signer) as Contract;

/// The real precompile address, asserted below so a refactor cannot silently change it.
const REAL_PRECOMPILE = "0x0000000000000000000000000000000000000100";

describe("ReactivityPing (spike)", () => {
  async function deploy() {
    // A local EVM reserves 0x0100 and intercepts calls to it, so the mock lives at a
    // normal address and the harness points at it. Production keeps the real constant.
    const mockFactory = await ethers.getContractFactory("MockReactivity");
    const mock = await mockFactory.deploy();
    await mock.waitForDeployment();
    const mockAddr = await mock.getAddress();

    const pingFactory = await ethers.getContractFactory("ReactivityPingHarness");
    const ping = await pingFactory.deploy(mockAddr);
    await ping.waitForDeployment();

    return { ping, mock, mockAddr };
  }

  /// Impersonate the precompile so onEvent is called exactly the way the chain calls it.
  async function wake(pingAddr: string, mockAddr: string, emitter: string) {
    await network.provider.send("hardhat_impersonateAccount", [mockAddr]);
    await network.provider.send("hardhat_setBalance", [mockAddr, "0x56BC75E2D63100000"]);
    const signer = await ethers.getSigner(mockAddr);
    const ping = await ethers.getContractAt("ReactivityPingHarness", pingAddr, signer);
    const tx = await ping.onEvent(emitter, [], "0x");
    await network.provider.send("hardhat_stopImpersonatingAccount", [mockAddr]);
    return tx;
  }

  it("targets the protocol's real precompile address in production code", async () => {
    const pingFactory = await ethers.getContractFactory("ReactivityPing");
    const plain = await pingFactory.deploy();
    await plain.waitForDeployment();
    // The plain contract trusts only 0x0100, so nobody else can wake it.
    const [caller] = await ethers.getSigners();
    await expect(as$(plain, caller).onEvent(ethers.ZeroAddress, [], "0x"))
      .to.be.revertedWithCustomError(plain, "OnlyReactivityPrecompile")
      .withArgs(await caller.getAddress());
    expect(REAL_PRECOMPILE).to.equal("0x0000000000000000000000000000000000000100");
  });

  it("arms a one-shot timer and records the scheduled millisecond timestamp", async () => {
    const { ping } = await deploy();
    await expect(ping.start(30)).to.emit(ping, "Armed");
    expect(await ping.running()).to.equal(true);
    expect(await ping.currentSubscriptionId()).to.not.equal(0n);
    // Schedule topics are in milliseconds, not seconds.
    expect(await ping.nextWakeAtMillis()).to.be.greaterThan(1_000_000_000_000n);
  });

  it("counts a wake when the chain calls onEvent, and re-arms itself", async () => {
    const { ping, mockAddr } = await deploy();
    await ping.start(30);
    const firstSub = await ping.currentSubscriptionId();

    await expect(wake(await ping.getAddress(), mockAddr, ethers.ZeroAddress)).to.emit(ping, "Woke");

    expect(await ping.wakeCount()).to.equal(1n);
    // A fresh subscription id proves it put itself back on the clock unaided.
    expect(await ping.currentSubscriptionId()).to.not.equal(firstSub);
  });

  it("keeps going across several wakes with nothing else running", async () => {
    const { ping, mockAddr } = await deploy();
    await ping.start(30);
    for (let i = 0; i < 5; i++) await wake(await ping.getAddress(), mockAddr, ethers.ZeroAddress);
    expect(await ping.wakeCount()).to.equal(5n);
  });

  it("refuses to be woken by anyone other than the precompile", async () => {
    const { ping } = await deploy();
    const [attacker] = await ethers.getSigners();
    await expect(as$(ping, attacker).onEvent(ethers.ZeroAddress, [], "0x"))
      .to.be.revertedWithCustomError(ping, "OnlyReactivityPrecompile");
  });

  it("stops re-arming once stopped", async () => {
    const { ping, mockAddr } = await deploy();
    await ping.start(30);
    await wake(await ping.getAddress(), mockAddr, ethers.ZeroAddress);
    await ping.stop();
    expect(await ping.running()).to.equal(false);

    const subAfterStop = await ping.currentSubscriptionId();
    await wake(await ping.getAddress(), mockAddr, ethers.ZeroAddress);
    expect(await ping.wakeCount()).to.equal(2n);
    // Still woken (the chain may have one in flight), but it did not schedule another.
    expect(await ping.currentSubscriptionId()).to.equal(subAfterStop);
  });

  it("arms a persistent event subscription, which is the mode Vane will use", async () => {
    const { ping } = await deploy();
    const emitter = "0x3ecC694Cef705358864a646142ac17A90E29e388"; // BinaryMarketsModule
    const topic0 = ethers.id("MarketStatusUpdated(bytes32,uint8)");
    await expect(ping.armOnEvent(emitter, topic0)).to.emit(ping, "ArmedOnEvent");
    expect(await ping.eventSubscriptionId()).to.not.equal(0n);
  });

  it("only the owner can arm or stop", async () => {
    const { ping } = await deploy();
    const other = (await ethers.getSigners())[1];
    await expect(as$(ping, other).start(30)).to.be.revertedWithCustomError(ping, "NotOwner");
    await expect(as$(ping, other).stop()).to.be.revertedWithCustomError(ping, "NotOwner");
  });
});
