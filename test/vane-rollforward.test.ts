import { expect } from "chai";
import { ethers, network } from "hardhat";
import type { Contract, Signer } from "ethers";

/// Without typechain, `.connect()` widens to BaseContract and loses the method types.
const as$ = (c: unknown, signer: Signer) => (c as Contract).connect(signer) as Contract;

const ONE = 1_000_000n; // collateral is 6 decimals, like Shannon tUSDC

/// topic0 of DreamDEX's MarketCreated. The agent treats this wake as "a new window opened,
/// go there", which is the step that used to need a person.
const TOPIC_MARKET_CREATED = "0xb5ec75cdb7dbcd28a5f50d152d8833334525a902ef5332ebc19bcf5c0011f8cd";
const TOPIC_SCHEDULE = "0x67aa3d752967d87d8944b9c7adf73172518777fa4703f336edee81f0736d8987";

/// Pinned as a constant in the agent, so the emitter check only passes for this address.
const MARKETS_MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";

/// Both venue ids are real, read off live Shannon. DreamDEX's own windows carry the first;
/// the throwaway "Pricefeed test" markets the same module creates carry the second. They
/// are otherwise identical to the agent, which is the whole reason the filter is the venue.
const DREAMDEX_VENUE = "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c";
const PRICEFEED_VENUE = "0x1a1e6821cde7d0159c0d293177871e09677b4e42307c7db3ba94f8648a5a050f";

/// The non-indexed half of MarketCreated, in order. Encoding the real shape rather than a
/// convenient one is the point: the agent reads three fixed head slots out of this by byte
/// offset, so a wrong layout here would let a wrong offset pass.
const CREATED_DATA_TYPES = [
  "uint256", // oracleQuestionId   head[0]
  "uint32", //  operatorId         head[1]
  "bytes32", // venueId            head[2]
  "address", // creator            head[3]
  "address", // collateral         head[4]
  "uint256", // yesId              head[5]
  "uint256", // noId               head[6]
  "uint64", //  nonce              head[7]
  "uint8", //   outcomeSlotCount   head[8]
  "uint8", //   marketType         head[9]
  "uint64", //  tradingStart       head[10]
  "uint64", //  expiry             head[11]
  "uint8", //   voidPolicy         head[12]
  "string", //  asset
  "uint256", // strike
  "string", //  question
  "bytes", //   context
];

describe("VaneAgent rolling itself forward", () => {
  async function deploy() {
    const [deployer, user, operator, stranger] = await ethers.getSigners();

    const collateral = await (await ethers.getContractFactory("MockCollateral")).deploy();
    await collateral.waitForDeployment();
    const otherCollateral = await (await ethers.getContractFactory("MockCollateral")).deploy();
    await otherCollateral.waitForDeployment();

    const poolFactory = await ethers.getContractFactory("MockBinaryPool");
    // The window it starts on, and the one the chain will open next.
    const poolA = await poolFactory.deploy(await collateral.getAddress());
    await poolA.waitForDeployment();
    const poolB = await poolFactory.deploy(await collateral.getAddress());
    await poolB.waitForDeployment();

    const reactivity = await (await ethers.getContractFactory("MockReactivity")).deploy();
    await reactivity.waitForDeployment();

    const agent = await (await ethers.getContractFactory("VaneAgentHarness")).deploy(
      await user.getAddress(),
      await collateral.getAddress(),
      await operator.getAddress(),
      await reactivity.getAddress(),
    );
    await agent.waitForDeployment();

    const agentAddr = await agent.getAddress();
    const poolAAddr = await poolA.getAddress();
    const poolBAddr = await poolB.getAddress();

    await collateral.mint(await user.getAddress(), 1000n * ONE);
    await as$(collateral, user).approve(agentAddr, 1000n * ONE);
    await as$(agent, user).deposit(100n * ONE);

    await as$(agent, user).setPoolAllowed(poolAAddr, true);
    await as$(agent, user).setActivePool(poolAAddr);
    await as$(agent, user).setPolicy(10n * ONE, 0, 0);
    await as$(agent, user).setTradingEnabled(true);
    await as$(agent, user).setRollForward(DREAMDEX_VENUE, 240);

    return {
      deployer, user, operator, stranger,
      collateral, otherCollateral, poolA, poolB, agent,
      agentAddr, poolAAddr, poolBAddr,
      reactivityAddr: await reactivity.getAddress(),
    };
  }

  async function now() {
    return (await ethers.provider.getBlock("latest"))!.timestamp;
  }

  /// Build a MarketCreated log the way the module emits one.
  async function created(opts: {
    pool: string;
    collateral: string;
    venue?: string;
    secondsLeft?: number;
    truncate?: boolean;
  }) {
    const expiry = (await now()) + (opts.secondsLeft ?? 3600);
    const data = ethers.AbiCoder.defaultAbiCoder().encode(CREATED_DATA_TYPES, [
      12345n, // oracleQuestionId
      2, // operatorId
      opts.venue ?? DREAMDEX_VENUE,
      ethers.ZeroAddress, // creator
      opts.collateral,
      1n, // yesId
      2n, // noId
      7n, // nonce
      2, // outcomeSlotCount
      0, // marketType: BINARY
      expiry - 300, // tradingStart
      expiry,
      0, // voidPolicy
      "BTC",
      0n, // strike
      "BTC closes at or above its opening price",
      "0x",
    ]);
    const topics = [
      TOPIC_MARKET_CREATED,
      "0x" + "22".repeat(32), // marketId
      ethers.zeroPadValue(ethers.ZeroAddress, 32), // market
      ethers.zeroPadValue(opts.pool, 32), // pool
    ];
    // A head that stops before the expiry slot must be refused, not read past.
    return { topics, data: opts.truncate ? data.slice(0, 2 + 320 * 2) : data, expiry };
  }

  async function wake(f: Awaited<ReturnType<typeof deploy>>, emitter: string, topics: string[], data: string) {
    await network.provider.send("hardhat_impersonateAccount", [f.reactivityAddr]);
    await network.provider.send("hardhat_setBalance", [f.reactivityAddr, "0x56BC75E2D63100000"]);
    const signer = await ethers.getSigner(f.reactivityAddr);
    const a = await ethers.getContractAt("VaneAgentHarness", f.agentAddr, signer);
    const tx = await a.onEvent(emitter, topics, data);
    await network.provider.send("hardhat_stopImpersonatingAccount", [f.reactivityAddr]);
    return tx;
  }

  // ------------------------------------------------------------------ the happy path

  it("moves onto a window the chain has just opened, with nobody in the loop", async () => {
    const f = await deploy();
    const ev = await created({ pool: f.poolBAddr, collateral: await f.collateral.getAddress() });

    await expect(wake(f, MARKETS_MODULE, ev.topics, ev.data))
      .to.emit(f.agent, "RolledForward")
      .withArgs(f.poolAAddr, f.poolBAddr, ev.expiry);

    expect(await f.agent.activePool()).to.equal(f.poolBAddr);
    expect(await f.agent.activePoolExpiry()).to.equal(ev.expiry);
    expect(await f.agent.rollCount()).to.equal(1n);
  });

  it("can trade the new window immediately, because it granted the allowance itself", async () => {
    const f = await deploy();
    const ev = await created({ pool: f.poolBAddr, collateral: await f.collateral.getAddress() });
    await wake(f, MARKETS_MODULE, ev.topics, ev.data);

    expect(await f.agent.poolAllowed(f.poolBAddr)).to.equal(true);

    // A plain market wake now lands on the new book and actually fills there.
    await expect(wake(f, MARKETS_MODULE, ["0x" + "99".repeat(32)], "0x"))
      .to.emit(f.agent, "Traded");
    expect(await f.poolB.orderCount()).to.equal(1n);
    expect(await f.poolA.orderCount()).to.equal(0n);
  });

  it("counts the wake even when it declines to move", async () => {
    const f = await deploy();
    const ev = await created({ pool: f.poolBAddr, collateral: await f.collateral.getAddress(), venue: PRICEFEED_VENUE });
    const before = await f.agent.wakeCount();
    await wake(f, MARKETS_MODULE, ev.topics, ev.data);
    expect(await f.agent.wakeCount()).to.equal(before + 1n);
  });

  // -------------------------------------------------------------- refusing bad windows

  it("ignores the pricefeed test markets, which differ ONLY by venue", async () => {
    const f = await deploy();
    const ev = await created({
      pool: f.poolBAddr,
      collateral: await f.collateral.getAddress(),
      venue: PRICEFEED_VENUE,
    });

    await expect(wake(f, MARKETS_MODULE, ev.topics, ev.data))
      .to.emit(f.agent, "RollSkipped")
      .withArgs(f.poolBAddr, "different venue");
    expect(await f.agent.activePool()).to.equal(f.poolAAddr);
    expect(await f.agent.rollCount()).to.equal(0n);
  });

  it("ignores a window that settles in a different token", async () => {
    const f = await deploy();
    const ev = await created({ pool: f.poolBAddr, collateral: await f.otherCollateral.getAddress() });
    await expect(wake(f, MARKETS_MODULE, ev.topics, ev.data))
      .to.emit(f.agent, "RollSkipped")
      .withArgs(f.poolBAddr, "different collateral");
    expect(await f.agent.activePool()).to.equal(f.poolAAddr);
  });

  it("ignores a window that dies before its own orders could be reclaimed", async () => {
    const f = await deploy();
    // 60s left, against a 240s floor. It would close before the orders could rest.
    const ev = await created({ pool: f.poolBAddr, collateral: await f.collateral.getAddress(), secondsLeft: 60 });
    await expect(wake(f, MARKETS_MODULE, ev.topics, ev.data))
      .to.emit(f.agent, "RollSkipped")
      .withArgs(f.poolBAddr, "window too short");
    expect(await f.agent.activePool()).to.equal(f.poolAAddr);
  });

  it("settles on the first tradable window of a burst, not the rest of it", async () => {
    const f = await deploy();
    const collateralAddr = await f.collateral.getAddress();
    const poolC = await (await ethers.getContractFactory("MockBinaryPool")).deploy(collateralAddr);
    await poolC.waitForDeployment();
    const poolCAddr = await poolC.getAddress();

    // A real burst arrives as several separate wakes in the same transaction.
    const first = await created({ pool: poolCAddr, collateral: collateralAddr, secondsLeft: 900 });
    await wake(f, MARKETS_MODULE, first.topics, first.data);
    expect(await f.agent.activePool()).to.equal(poolCAddr);

    // The rest of the burst, including a much longer window, must not drag it off a book
    // it can trade. One roll, not three.
    const longer = await created({ pool: f.poolBAddr, collateral: collateralAddr, secondsLeft: 7200 });
    await expect(wake(f, MARKETS_MODULE, longer.topics, longer.data))
      .to.emit(f.agent, "RollSkipped")
      .withArgs(f.poolBAddr, "current window still open");
    expect(await f.agent.activePool()).to.equal(poolCAddr);
    expect(await f.agent.rollCount()).to.equal(1n);
  });

  it("stays put while its own window is open, however long the new one is", async () => {
    const f = await deploy();
    const collateralAddr = await f.collateral.getAddress();

    // Settle onto a four-hour window.
    const first = await created({ pool: f.poolBAddr, collateral: collateralAddr, secondsLeft: 14400 });
    await wake(f, MARKETS_MODULE, first.topics, first.data);
    expect(await f.agent.activePool()).to.equal(f.poolBAddr);

    // DreamDEX opens a DAY-long window. The agent is mid-window and must ignore it,
    // rather than abandoning a book it is trading.
    const daily = await created({ pool: f.poolAAddr, collateral: collateralAddr, secondsLeft: 86400 });
    await expect(wake(f, MARKETS_MODULE, daily.topics, daily.data))
      .to.emit(f.agent, "RollSkipped")
      .withArgs(f.poolAAddr, "current window still open");
    expect(await f.agent.activePool()).to.equal(f.poolBAddr);
    expect(await f.agent.rollCount()).to.equal(1n);
  });

  it("moves on once its own window has ended", async () => {
    const f = await deploy();
    const collateralAddr = await f.collateral.getAddress();

    const first = await created({ pool: f.poolBAddr, collateral: collateralAddr, secondsLeft: 900 });
    await wake(f, MARKETS_MODULE, first.topics, first.data);
    expect(await f.agent.activePool()).to.equal(f.poolBAddr);

    // Run the clock past the end of that window. increaseTime only takes effect on the
    // next block, so mine one before reading `now`.
    await network.provider.send("evm_increaseTime", [950]);
    await network.provider.send("evm_mine", []);
    const next = await created({ pool: f.poolAAddr, collateral: collateralAddr, secondsLeft: 900 });
    await expect(wake(f, MARKETS_MODULE, next.topics, next.data))
      .to.emit(f.agent, "RolledForward")
      .withArgs(f.poolBAddr, f.poolAAddr, next.expiry);
    expect(await f.agent.activePool()).to.equal(f.poolAAddr);
    expect(await f.agent.rollCount()).to.equal(2n);
  });

  it("takes a five-minute window rather than hold out for a long one", async () => {
    // Roughly half the venue's MarketCreated logs never produce a wake, so an agent that
    // only accepted long windows could idle for a long time. The abundant short windows
    // are the resilient choice, and the floor still rejects anything shorter.
    const f = await deploy();
    const ev = await created({ pool: f.poolBAddr, collateral: await f.collateral.getAddress(), secondsLeft: 300 });
    await expect(wake(f, MARKETS_MODULE, ev.topics, ev.data))
      .to.emit(f.agent, "RolledForward")
      .withArgs(f.poolAAddr, f.poolBAddr, ev.expiry);
    expect(await f.agent.activePool()).to.equal(f.poolBAddr);
  });

  it("does not roll while rolling is switched off", async () => {
    const f = await deploy();
    await as$(f.agent, f.user).setRollForward(ethers.ZeroHash, 240);
    const ev = await created({ pool: f.poolBAddr, collateral: await f.collateral.getAddress() });
    await expect(wake(f, MARKETS_MODULE, ev.topics, ev.data))
      .to.emit(f.agent, "RollSkipped")
      .withArgs(ethers.ZeroAddress, "rolling not configured");
    expect(await f.agent.activePool()).to.equal(f.poolAAddr);
  });

  it("refuses a MarketCreated that did not come from the markets module", async () => {
    const f = await deploy();
    const ev = await created({ pool: f.poolBAddr, collateral: await f.collateral.getAddress() });
    await expect(wake(f, f.poolAAddr, ev.topics, ev.data))
      .to.emit(f.agent, "RollSkipped")
      .withArgs(ethers.ZeroAddress, "wrong emitter");
    expect(await f.agent.activePool()).to.equal(f.poolAAddr);
  });

  it("refuses a payload too short to hold the fields it reads", async () => {
    const f = await deploy();
    const ev = await created({ pool: f.poolBAddr, collateral: await f.collateral.getAddress(), truncate: true });
    await expect(wake(f, MARKETS_MODULE, ev.topics, ev.data))
      .to.emit(f.agent, "RollSkipped")
      .withArgs(ethers.ZeroAddress, "unexpected event shape");
    expect(await f.agent.activePool()).to.equal(f.poolAAddr);
  });

  // ------------------------------------------ the order must not outlive the window

  it("clamps its order to the end of the window it just moved onto", async () => {
    const f = await deploy();
    const collateralAddr = await f.collateral.getAddress();

    // A five-minute window. The agent's flat 300s order lifetime would land past the end
    // of it, and the venue rejects that outright with OrderExpiryBeyondMarket().
    const ev = await created({ pool: f.poolBAddr, collateral: collateralAddr, secondsLeft: 300 });
    await f.poolB.setMarketExpiry(ev.expiry);
    await wake(f, MARKETS_MODULE, ev.topics, ev.data);
    expect(await f.agent.activePool()).to.equal(f.poolBAddr);

    await expect(wake(f, MARKETS_MODULE, ["0x" + "99".repeat(32)], "0x"))
      .to.emit(f.agent, "Traded");
    expect(await f.poolB.orderCount()).to.equal(1n);

    const order = await f.poolB.orders(0);
    expect(order.expiresAt).to.be.lessThanOrEqual(BigInt(ev.expiry));
  });

  it("would be rejected by the venue without that clamp", async () => {
    // Guards the test above: prove the mock really does enforce the rule, so a passing
    // clamp test cannot be passing vacuously.
    const f = await deploy();
    const collateralAddr = await f.collateral.getAddress();
    const ev = await created({ pool: f.poolBAddr, collateral: collateralAddr, secondsLeft: 300 });
    await f.poolB.setMarketExpiry(ev.expiry);

    // Point it by hand instead of rolling, so the agent never learns the window's end and
    // therefore cannot clamp.
    await as$(f.agent, f.user).setPoolAllowed(f.poolBAddr, true);
    await as$(f.agent, f.user).setActivePool(f.poolBAddr);
    await expect(wake(f, MARKETS_MODULE, ["0x" + "99".repeat(32)], "0x"))
      .to.emit(f.agent, "TradeSkipped")
      .withArgs(f.poolBAddr, "pool rejected the order");
    expect(await f.poolB.orderCount()).to.equal(0n);
  });

  // ------------------------------------------------------------ not stranding the escrow

  it("still reclaims from the OLD book after moving on", async () => {
    const f = await deploy();
    const collateralAddr = await f.collateral.getAddress();

    // Trade the first window, so escrow is resting in pool A.
    await wake(f, MARKETS_MODULE, ["0x" + "99".repeat(32)], "0x");
    expect(await f.poolA.orderCount()).to.equal(1n);
    expect(await f.agent.openOrderCount()).to.equal(1n);
    expect(await f.agent.orderPool()).to.equal(f.poolAAddr);

    // Move to the next window while that order is still live, so nothing is freed yet.
    const ev = await created({ pool: f.poolBAddr, collateral: collateralAddr });
    await wake(f, MARKETS_MODULE, ev.topics, ev.data);
    expect(await f.agent.activePool()).to.equal(f.poolBAddr);
    expect(await f.agent.openOrderCount()).to.equal(1n);
    expect(await f.agent.orderPool()).to.equal(f.poolAAddr);

    // Once it expires, the housekeeping wake must go to pool A, not to the pool the agent
    // has since moved onto. Reclaiming against the wrong book strands the collateral.
    await network.provider.send("evm_increaseTime", [400]);
    const before = await f.collateral.balanceOf(f.agentAddr);
    await expect(wake(f, MARKETS_MODULE, [TOPIC_SCHEDULE], "0x"))
      .to.emit(f.agent, "Reclaimed");
    expect(await f.collateral.balanceOf(f.agentAddr)).to.be.greaterThan(before);
    expect(await f.agent.openOrderCount()).to.equal(0n);
  });

  it("keeps the old book approved while our money is still resting in it", async () => {
    const f = await deploy();
    await wake(f, MARKETS_MODULE, ["0x" + "99".repeat(32)], "0x");
    expect(await f.agent.openOrderCount()).to.equal(1n);

    const ev = await created({ pool: f.poolBAddr, collateral: await f.collateral.getAddress() });
    await wake(f, MARKETS_MODULE, ev.topics, ev.data);

    expect(await f.agent.poolAllowed(f.poolAAddr)).to.equal(true);
    expect(await f.collateral.allowance(f.agentAddr, f.poolAAddr)).to.be.greaterThan(0n);
  });

  it("drops the old book's allowance once nothing of ours is left in it", async () => {
    const f = await deploy();
    // No orders were ever placed, so there is nothing to keep the approval alive for.
    const ev = await created({ pool: f.poolBAddr, collateral: await f.collateral.getAddress() });
    await expect(wake(f, MARKETS_MODULE, ev.topics, ev.data))
      .to.emit(f.agent, "PoolAllowed")
      .withArgs(f.poolAAddr, false);

    expect(await f.agent.poolAllowed(f.poolAAddr)).to.equal(false);
    expect(await f.collateral.allowance(f.agentAddr, f.poolAAddr)).to.equal(0n);
  });

  // ------------------------------------------------------------------------- policy

  it("is owner-only to configure, and a manual pool choice clears the known expiry", async () => {
    const f = await deploy();
    await expect(as$(f.agent, f.stranger).setRollForward(DREAMDEX_VENUE, 240))
      .to.be.revertedWithCustomError(f.agent, "NotOwner");

    const ev = await created({ pool: f.poolBAddr, collateral: await f.collateral.getAddress() });
    await wake(f, MARKETS_MODULE, ev.topics, ev.data);
    expect(await f.agent.activePoolExpiry()).to.equal(ev.expiry);

    // Taking the wheel by hand must not leave a stale expiry that blocks the next roll.
    await as$(f.agent, f.user).setActivePool(f.poolAAddr);
    expect(await f.agent.activePoolExpiry()).to.equal(0n);
  });

  it("withdrawal still works while the agent is rolling itself along", async () => {
    const f = await deploy();
    const ev = await created({ pool: f.poolBAddr, collateral: await f.collateral.getAddress() });
    await wake(f, MARKETS_MODULE, ev.topics, ev.data);

    const before = await f.collateral.balanceOf(await f.user.getAddress());
    await as$(f.agent, f.user).withdraw(0);
    expect(await f.collateral.balanceOf(await f.user.getAddress())).to.be.greaterThan(before);
  });
});
