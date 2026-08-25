import { expect } from "chai";
import { ethers, network } from "hardhat";
import type { Contract, Signer } from "ethers";

/// Without typechain, `.connect()` widens to BaseContract and loses the method types.
const as$ = (c: unknown, signer: Signer) => (c as Contract).connect(signer) as Contract;

const ONE = 1_000_000n; // collateral is 6 decimals, like Shannon tUSDC

/// topic0 of Schedule(uint256). A one-shot armed with scheduleAtTimestamp fires this, and
/// it is how the agent tells a housekeeping wake apart from a market wake.
const TOPIC_SCHEDULE = "0x67aa3d752967d87d8944b9c7adf73172518777fa4703f336edee81f0736d8987";

/// The agent pins the module address as a constant, since it is identical on Shannon and
/// mainnet, so the mock has to live exactly there.
const MARKETS_MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";

const MARKET_ID = "0x" + "11".repeat(32);

describe("VaneAgent getting money back", () => {
  async function deploy() {
    const [deployer, user, operator, stranger] = await ethers.getSigners();

    const collateral = await (await ethers.getContractFactory("MockCollateral")).deploy();
    await collateral.waitForDeployment();
    const pool = await (await ethers.getContractFactory("MockBinaryPool")).deploy(await collateral.getAddress());
    await pool.waitForDeployment();
    const reactivity = await (await ethers.getContractFactory("MockReactivity")).deploy();
    await reactivity.waitForDeployment();
    const outcome = await (await ethers.getContractFactory("MockOutcomeToken")).deploy();
    await outcome.waitForDeployment();

    const YES = 1n;
    const NO = 2n;
    const market = await (await ethers.getContractFactory("MockBinaryMarket")).deploy(
      await outcome.getAddress(),
      YES,
      NO,
    );
    await market.waitForDeployment();

    // Put the module mock at the constant address the agent trusts.
    const moduleImpl = await (await ethers.getContractFactory("MockMarketsModule")).deploy();
    await moduleImpl.waitForDeployment();
    const runtime = await ethers.provider.getCode(await moduleImpl.getAddress());
    await network.provider.send("hardhat_setCode", [MARKETS_MODULE, runtime]);
    const module = await ethers.getContractAt("MockMarketsModule", MARKETS_MODULE);
    await module.configure(await outcome.getAddress(), await collateral.getAddress());
    // hardhat_setCode replaces CODE but keeps STORAGE, so flags set by an earlier test
    // survive at this fixed address. Reset it or those tests leak into these.
    await module.setRejectEverything(false);

    const agent = await (await ethers.getContractFactory("VaneAgentHarness")).deploy(
      await user.getAddress(),
      await collateral.getAddress(),
      await operator.getAddress(),
      await reactivity.getAddress(),
    );
    await agent.waitForDeployment();
    const agentAddr = await agent.getAddress();
    const poolAddr = await pool.getAddress();

    await collateral.mint(await user.getAddress(), 1000n * ONE);
    await as$(collateral, user).approve(agentAddr, 1000n * ONE);
    await as$(agent, user).deposit(100n * ONE);

    await as$(agent, user).setPoolAllowed(poolAddr, true);
    await as$(agent, user).setActivePool(poolAddr);
    await as$(agent, user).setPolicy(10n * ONE, 0, 0);
    await as$(agent, user).setTradingEnabled(true);

    return {
      deployer, user, operator, stranger,
      collateral, pool, agent, outcome, market, module,
      agentAddr, poolAddr,
      marketAddr: await market.getAddress(),
      reactivityAddr: await reactivity.getAddress(),
      YES, NO,
    };
  }

  async function wake(agentAddr: string, reactivityAddr: string, emitter: string, topics: string[]) {
    await network.provider.send("hardhat_impersonateAccount", [reactivityAddr]);
    await network.provider.send("hardhat_setBalance", [reactivityAddr, "0x56BC75E2D63100000"]);
    const signer = await ethers.getSigner(reactivityAddr);
    const a = await ethers.getContractAt("VaneAgentHarness", agentAddr, signer);
    const tx = await a.onEvent(emitter, topics, "0x");
    await network.provider.send("hardhat_stopImpersonatingAccount", [reactivityAddr]);
    return tx;
  }

  describe("reclaiming escrow", () => {
    it("frees collateral that expired orders were holding", async () => {
      const f = await deploy();
      await as$(f.agent, f.operator).poke(f.poolAddr);
      // Escrow is locked in the pool until something cancels the order.
      expect(await f.collateral.balanceOf(f.agentAddr)).to.be.lessThan(100n * ONE);

      await expect(as$(f.agent, f.stranger).reclaimExpired(f.poolAddr)).to.emit(f.agent, "Reclaimed");
      expect(await f.collateral.balanceOf(f.agentAddr)).to.equal(100n * ONE);
    });

    it("is permissionless, so funds are not stranded if the operator vanishes", async () => {
      const f = await deploy();
      await as$(f.agent, f.operator).poke(f.poolAddr);
      await as$(f.agent, f.user).setOperator(ethers.ZeroAddress);
      // A stranger can free the money, and it returns to the AGENT, not to the caller.
      await as$(f.agent, f.stranger).reclaimExpired(f.poolAddr);
      expect(await f.collateral.balanceOf(f.agentAddr)).to.equal(100n * ONE);
    });

    it("says so plainly when there is nothing to reclaim", async () => {
      const f = await deploy();
      await expect(as$(f.agent, f.stranger).reclaimExpired(f.poolAddr)).to.emit(f.agent, "ReclaimSkipped");
    });

    it("clears the recorded ids so a second reclaim is a no-op", async () => {
      const f = await deploy();
      await as$(f.agent, f.operator).poke(f.poolAddr);
      await as$(f.agent, f.stranger).reclaimExpired(f.poolAddr);
      await expect(as$(f.agent, f.stranger).reclaimExpired(f.poolAddr)).to.emit(f.agent, "ReclaimSkipped");
    });
  });

  describe("redeeming winnings", () => {
    it("turns a winning position back into collateral", async () => {
      const f = await deploy();
      await f.outcome.mint(f.agentAddr, f.YES, 25n * ONE);
      await f.collateral.mint(MARKETS_MODULE, 100n * ONE); // module funds the payout
      await f.market.resolveTo(0); // YES wins

      const before = await f.collateral.balanceOf(f.agentAddr);
      await expect(as$(f.agent, f.stranger).sweepSettled(MARKET_ID, f.marketAddr))
        .to.emit(f.agent, "Redeemed");
      expect((await f.collateral.balanceOf(f.agentAddr)) - before).to.equal(25n * ONE);
      expect(await f.agent.redeemCount()).to.equal(1n);
    });

    it("grants the module operator on the outcome token by itself", async () => {
      const f = await deploy();
      expect(await f.outcome.isOperator(f.agentAddr, MARKETS_MODULE)).to.equal(false);
      await f.outcome.mint(f.agentAddr, f.YES, 5n * ONE);
      await f.collateral.mint(MARKETS_MODULE, 100n * ONE);
      await f.market.resolveTo(0);
      await as$(f.agent, f.stranger).sweepSettled(MARKET_ID, f.marketAddr);
      // Redemption pulls the position from us, so without this grant it reverts.
      expect(await f.outcome.isOperator(f.agentAddr, MARKETS_MODULE)).to.equal(true);
    });

    it("claims BOTH sides of a voided market", async () => {
      const f = await deploy();
      await f.outcome.mint(f.agentAddr, f.YES, 4n * ONE);
      await f.outcome.mint(f.agentAddr, f.NO, 6n * ONE);
      await f.collateral.mint(MARKETS_MODULE, 100n * ONE);
      await f.market.voidIt();

      const before = await f.collateral.balanceOf(f.agentAddr);
      await as$(f.agent, f.stranger).sweepSettled(MARKET_ID, f.marketAddr);
      // A voided market pays both sides, so both positions must be claimed.
      expect((await f.collateral.balanceOf(f.agentAddr)) - before).to.equal(10n * ONE);
      expect(await f.agent.redeemCount()).to.equal(2n);
    });

    it("redeems the NO side when NO wins", async () => {
      const f = await deploy();
      await f.outcome.mint(f.agentAddr, f.YES, 7n * ONE);
      await f.outcome.mint(f.agentAddr, f.NO, 3n * ONE);
      await f.collateral.mint(MARKETS_MODULE, 100n * ONE);
      await f.market.resolveTo(1); // NO wins

      const before = await f.collateral.balanceOf(f.agentAddr);
      await as$(f.agent, f.stranger).sweepSettled(MARKET_ID, f.marketAddr);
      // Only the winning side pays; the losing position is worth nothing.
      expect((await f.collateral.balanceOf(f.agentAddr)) - before).to.equal(3n * ONE);
    });

    it("does nothing for a market that has not settled", async () => {
      const f = await deploy();
      await f.outcome.mint(f.agentAddr, f.YES, 5n * ONE);
      await expect(as$(f.agent, f.stranger).sweepSettled(MARKET_ID, f.marketAddr))
        .to.emit(f.agent, "SweepSkipped");
      expect(await f.agent.redeemCount()).to.equal(0n);
    });

    it("does nothing when we hold no position", async () => {
      const f = await deploy();
      await f.market.resolveTo(0);
      await expect(as$(f.agent, f.stranger).sweepSettled(MARKET_ID, f.marketAddr))
        .to.emit(f.agent, "SweepSkipped");
      expect(await f.agent.redeemCount()).to.equal(0n);
    });

    it("survives the module rejecting the redeem", async () => {
      const f = await deploy();
      await f.outcome.mint(f.agentAddr, f.YES, 5n * ONE);
      await f.market.resolveTo(0);
      await f.module.setRejectEverything(true);
      await expect(as$(f.agent, f.stranger).sweepSettled(MARKET_ID, f.marketAddr))
        .to.emit(f.agent, "SweepSkipped");
    });
  });

  describe("the scheduled housekeeping wake", () => {
    it("reclaims and redeems instead of trading", async () => {
      const f = await deploy();
      await as$(f.agent, f.operator).poke(f.poolAddr);
      const tradesBefore = await f.agent.tradeCount();

      await f.outcome.mint(f.agentAddr, f.YES, 5n * ONE);
      await f.collateral.mint(MARKETS_MODULE, 100n * ONE);
      await f.market.resolveTo(0);
      await as$(f.agent, f.operator).setPendingMarket(MARKET_ID, f.marketAddr);

      // A Schedule topic means the one-shot timer fired: housekeeping, not trading.
      await wake(f.agentAddr, f.reactivityAddr, f.poolAddr, [TOPIC_SCHEDULE]);

      expect(await f.agent.tradeCount()).to.equal(tradesBefore); // it did NOT trade
      expect(await f.agent.reclaimCount()).to.equal(1n);
      expect(await f.agent.redeemCount()).to.equal(1n);
    });

    it("still trades on a normal market wake", async () => {
      const f = await deploy();
      const otherTopic = "0x" + "22".repeat(32);
      await expect(wake(f.agentAddr, f.reactivityAddr, f.poolAddr, [otherTopic])).to.emit(f.agent, "Traded");
      expect(await f.agent.tradeCount()).to.equal(1n);
    });

    it("housekeeps safely with nothing pending", async () => {
      const f = await deploy();
      await wake(f.agentAddr, f.reactivityAddr, f.poolAddr, [TOPIC_SCHEDULE]);
      expect(await f.agent.wakeCount()).to.equal(1n);
      expect(await f.agent.tradeCount()).to.equal(0n);
    });
  });

  describe("strategy", () => {
    it("crosses the spread by default, so orders actually fill", async () => {
      const f = await deploy();
      await as$(f.agent, f.operator).poke(f.poolAddr);
      const order = await f.pool.orders(0);
      // 0.95 probability, and MARKET (immediate or cancel) rather than a resting post-only.
      expect(order.price).to.equal(950_000n);
      expect(await f.agent.orderType()).to.equal(2n);
    });

    it("honours a configured price and order type", async () => {
      const f = await deploy();
      await as$(f.agent, f.user).setStrategy(600_000n, 3);
      await as$(f.agent, f.operator).poke(f.poolAddr);
      const order = await f.pool.orders(0);
      expect(order.price).to.equal(600_000n);
      expect(await f.agent.orderType()).to.equal(3n);
    });
  });
});
