import { expect } from "chai";
import { ethers, network } from "hardhat";
import type { Contract, Signer } from "ethers";

/// Without typechain, `.connect()` widens to BaseContract and loses the method types.
const as$ = (c: unknown, signer: Signer) => (c as Contract).connect(signer) as Contract;

const ONE = 1_000_000n; // collateral is 6 decimals, like Shannon's tUSDC

describe("VaneAgent", () => {
  async function deploy() {
    const [deployer, user, operator, stranger] = await ethers.getSigners();

    const collateral = await (await ethers.getContractFactory("MockCollateral")).deploy();
    await collateral.waitForDeployment();

    const pool = await (await ethers.getContractFactory("MockBinaryPool")).deploy(await collateral.getAddress());
    await pool.waitForDeployment();

    // Stands in for the reactivity precompile, which a local EVM will not let us place at 0x0100.
    const reactivity = await (await ethers.getContractFactory("MockReactivity")).deploy();
    await reactivity.waitForDeployment();

    const agent = await (await ethers.getContractFactory("VaneAgentHarness")).deploy(
      await user.getAddress(),
      await collateral.getAddress(),
      await operator.getAddress(),
      await reactivity.getAddress(),
    );
    await agent.waitForDeployment();

    // Fund the user and move collateral into the agent.
    await collateral.mint(await user.getAddress(), 1000n * ONE);
    await as$(collateral, user).approve(await agent.getAddress(), 1000n * ONE);
    await as$(agent, user).deposit(100n * ONE);

    return {
      deployer, user, operator, stranger,
      collateral, pool, agent,
      reactivityAddr: await reactivity.getAddress(),
      agentAddr: await agent.getAddress(),
      poolAddr: await pool.getAddress(),
    };
  }

  /// Wake the agent exactly the way the chain does: a call from the precompile.
  async function wake(agentAddr: string, reactivityAddr: string, emitter: string) {
    await network.provider.send("hardhat_impersonateAccount", [reactivityAddr]);
    await network.provider.send("hardhat_setBalance", [reactivityAddr, "0x56BC75E2D63100000"]);
    const signer = await ethers.getSigner(reactivityAddr);
    const a = await ethers.getContractAt("VaneAgentHarness", agentAddr, signer);
    const tx = await a.onEvent(emitter, [], "0x");
    await network.provider.send("hardhat_stopImpersonatingAccount", [reactivityAddr]);
    return tx;
  }

  async function armForTrading(f: Awaited<ReturnType<typeof deploy>>) {
    await as$(f.agent, f.user).setPoolAllowed(f.poolAddr, true);
    await as$(f.agent, f.user).setActivePool(f.poolAddr);
    await as$(f.agent, f.user).setPolicy(10n * ONE, 5n * ONE, 0);
    await as$(f.agent, f.user).setTradingEnabled(true);
  }

  // ------------------------------------------------------------- custody safety

  describe("custody", () => {
    it("lets only the owner withdraw", async () => {
      const f = await deploy();
      await expect(as$(f.agent, f.operator).withdraw(ONE)).to.be.revertedWithCustomError(f.agent, "NotOwner");
      await expect(as$(f.agent, f.stranger).withdraw(ONE)).to.be.revertedWithCustomError(f.agent, "NotOwner");
      await expect(as$(f.agent, f.deployer).withdraw(ONE)).to.be.revertedWithCustomError(f.agent, "NotOwner");
    });

    it("withdraws even while trading is live, which is the point of the design", async () => {
      const f = await deploy();
      await armForTrading(f);
      const before = await f.collateral.balanceOf(await f.user.getAddress());
      await as$(f.agent, f.user).withdraw(0); // 0 means everything
      const after = await f.collateral.balanceOf(await f.user.getAddress());
      expect(after - before).to.equal(100n * ONE);
      expect(await f.collateral.balanceOf(f.agentAddr)).to.equal(0n);
    });

    it("withdraws even after the operator has been cleared and trading disabled", async () => {
      const f = await deploy();
      await as$(f.agent, f.user).setOperator(ethers.ZeroAddress);
      await as$(f.agent, f.user).setTradingEnabled(false);
      await as$(f.agent, f.user).withdraw(0);
      expect(await f.collateral.balanceOf(f.agentAddr)).to.equal(0n);
    });

    it("never lets the operator move collateral out", async () => {
      const f = await deploy();
      await expect(as$(f.agent, f.operator).emergencyExit()).to.be.revertedWithCustomError(f.agent, "NotOwner");
      await expect(as$(f.agent, f.operator).rescueToken(await f.collateral.getAddress(), ONE))
        .to.be.revertedWithCustomError(f.agent, "NotOwner");
      expect(await f.collateral.balanceOf(f.agentAddr)).to.equal(100n * ONE);
    });

    it("refuses to rescue the trading collateral, so rescue is not a back door", async () => {
      const f = await deploy();
      await expect(as$(f.agent, f.user).rescueToken(await f.collateral.getAddress(), ONE))
        .to.be.revertedWithCustomError(f.agent, "CollateralIsNotRescuable");
    });

    it("emergencyExit stops trading and returns everything", async () => {
      const f = await deploy();
      await armForTrading(f);
      await as$(f.agent, f.user).emergencyExit();
      expect(await f.agent.tradingEnabled()).to.equal(false);
      expect(await f.collateral.balanceOf(f.agentAddr)).to.equal(0n);
    });
  });

  // ------------------------------------------------------------ the chain wakes

  describe("being woken by the chain", () => {
    it("refuses to be woken by anyone other than the precompile", async () => {
      const f = await deploy();
      await expect(as$(f.agent, f.stranger).onEvent(f.poolAddr, [], "0x"))
        .to.be.revertedWithCustomError(f.agent, "OnlyReactivityPrecompile");
    });

    it("trades when the chain wakes it", async () => {
      const f = await deploy();
      await armForTrading(f);
      await expect(wake(f.agentAddr, f.reactivityAddr, f.poolAddr)).to.emit(f.agent, "Traded");
      expect(await f.agent.tradeCount()).to.equal(1n);
      expect(await f.pool.orderCount()).to.equal(1n);
    });

    it("counts the wake even when it decides not to trade", async () => {
      const f = await deploy();
      // Not armed: pool is not on the allowlist.
      await expect(wake(f.agentAddr, f.reactivityAddr, f.poolAddr)).to.emit(f.agent, "TradeSkipped");
      expect(await f.agent.wakeCount()).to.equal(1n);
      expect(await f.agent.tradeCount()).to.equal(0n);
    });

    it("acts on the configured pool when the wake comes from the markets module", async () => {
      const f = await deploy();
      await armForTrading(f);
      // Reactivity events are emitted by the markets module, which is NOT a trading venue.
      const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";
      await expect(wake(f.agentAddr, f.reactivityAddr, MODULE)).to.emit(f.agent, "Traded");
      expect(await f.pool.orderCount()).to.equal(1n);
    });

    it("skips cleanly when woken with no active pool configured", async () => {
      const f = await deploy();
      await as$(f.agent, f.user).setPolicy(10n * ONE, 0, 0);
      await as$(f.agent, f.user).setTradingEnabled(true);
      const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";
      await expect(wake(f.agentAddr, f.reactivityAddr, MODULE)).to.emit(f.agent, "TradeSkipped");
      expect(await f.agent.wakeCount()).to.equal(1n);
    });

    it("never reverts the wake when the pool rejects the order", async () => {
      const f = await deploy();
      await armForTrading(f);
      await f.pool.setRejectEverything(true);
      // A revert here would roll back the wake and hide that the chain called us at all.
      await expect(wake(f.agentAddr, f.reactivityAddr, f.poolAddr)).to.emit(f.agent, "TradeSkipped");
      expect(await f.agent.wakeCount()).to.equal(1n);
      expect(await f.agent.tradeCount()).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------- policy

  describe("risk policy", () => {
    it("will not trade a pool that is not on the allowlist", async () => {
      const f = await deploy();
      await as$(f.agent, f.user).setPolicy(10n * ONE, 0, 0);
      await as$(f.agent, f.user).setTradingEnabled(true);
      await expect(as$(f.agent, f.operator).poke(f.poolAddr)).to.emit(f.agent, "TradeSkipped");
      expect(await f.pool.orderCount()).to.equal(0n);
    });

    it("spends no more than maxPerWindow", async () => {
      const f = await deploy();
      await as$(f.agent, f.user).setPoolAllowed(f.poolAddr, true);
      await as$(f.agent, f.user).setPolicy(10n * ONE, 0, 0);
      await as$(f.agent, f.user).setTradingEnabled(true);

      const before = await f.collateral.balanceOf(f.agentAddr);
      await as$(f.agent, f.operator).poke(f.poolAddr);
      const spent = before - (await f.collateral.balanceOf(f.agentAddr));
      expect(spent).to.be.lessThanOrEqual(10n * ONE);
      expect(spent).to.be.greaterThan(0n);
    });

    it("keeps the reserve untouched", async () => {
      const f = await deploy();
      await as$(f.agent, f.user).setPoolAllowed(f.poolAddr, true);
      // Budget larger than the balance, so only the reserve can hold it back.
      await as$(f.agent, f.user).setPolicy(1000n * ONE, 95n * ONE, 0);
      await as$(f.agent, f.user).setTradingEnabled(true);
      await as$(f.agent, f.operator).poke(f.poolAddr);
      expect(await f.collateral.balanceOf(f.agentAddr)).to.be.greaterThanOrEqual(95n * ONE);
    });

    it("does not trade when the balance is at or below the reserve", async () => {
      const f = await deploy();
      await as$(f.agent, f.user).setPoolAllowed(f.poolAddr, true);
      await as$(f.agent, f.user).setPolicy(10n * ONE, 100n * ONE, 0);
      await as$(f.agent, f.user).setTradingEnabled(true);
      await expect(as$(f.agent, f.operator).poke(f.poolAddr)).to.emit(f.agent, "TradeSkipped");
      expect(await f.pool.orderCount()).to.equal(0n);
    });

    it("rounds quantity down onto the venue lot grid", async () => {
      const f = await deploy();
      await armForTrading(f);
      await as$(f.agent, f.user).setLotSize(1000);
      await as$(f.agent, f.operator).poke(f.poolAddr);
      const order = await f.pool.orders(0);
      // A live Shannon pool rejects an off-grid quantity with InvalidQuantity.
      expect(order.quantity % 1000n).to.equal(0n);
    });

    it("skips when the budget cannot buy a single lot", async () => {
      const f = await deploy();
      await armForTrading(f);
      // A lot so large that size/price rounds down to zero lots.
      await as$(f.agent, f.user).setLotSize(10n ** 18n);
      await expect(as$(f.agent, f.operator).poke(f.poolAddr)).to.emit(f.agent, "TradeSkipped");
      expect(await f.pool.orderCount()).to.equal(0n);
    });

    it("honours the cooldown between trades on one pool", async () => {
      const f = await deploy();
      await as$(f.agent, f.user).setPoolAllowed(f.poolAddr, true);
      await as$(f.agent, f.user).setPolicy(10n * ONE, 0, 3600);
      await as$(f.agent, f.user).setTradingEnabled(true);

      await as$(f.agent, f.operator).poke(f.poolAddr);
      expect(await f.pool.orderCount()).to.equal(1n);
      await expect(as$(f.agent, f.operator).poke(f.poolAddr)).to.emit(f.agent, "TradeSkipped");
      expect(await f.pool.orderCount()).to.equal(1n);
    });

    it("does not trade while trading is disabled", async () => {
      const f = await deploy();
      await as$(f.agent, f.user).setPoolAllowed(f.poolAddr, true);
      await as$(f.agent, f.user).setPolicy(10n * ONE, 0, 0);
      await expect(as$(f.agent, f.operator).poke(f.poolAddr)).to.emit(f.agent, "TradeSkipped");
      expect(await f.pool.orderCount()).to.equal(0n);
    });

    it("lets the operator trade but not set policy", async () => {
      const f = await deploy();
      await expect(as$(f.agent, f.operator).setPolicy(1, 2, 3)).to.be.revertedWithCustomError(f.agent, "NotOwner");
      await expect(as$(f.agent, f.operator).setPoolAllowed(f.poolAddr, true))
        .to.be.revertedWithCustomError(f.agent, "NotOwner");
    });

    it("stops a revoked operator from trading", async () => {
      const f = await deploy();
      await armForTrading(f);
      await as$(f.agent, f.user).setOperator(ethers.ZeroAddress);
      await expect(as$(f.agent, f.operator).poke(f.poolAddr))
        .to.be.revertedWithCustomError(f.agent, "NotOperatorOrOwner");
    });

    it("revoking a pool also removes its allowance to pull collateral", async () => {
      const f = await deploy();
      await as$(f.agent, f.user).setPoolAllowed(f.poolAddr, true);
      expect(await f.collateral.allowance(f.agentAddr, f.poolAddr)).to.be.greaterThan(0n);
      await as$(f.agent, f.user).setPoolAllowed(f.poolAddr, false);
      expect(await f.collateral.allowance(f.agentAddr, f.poolAddr)).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------- deposits

  describe("deposits", () => {
    it("accepts collateral from anyone but still pays out only to the owner", async () => {
      const f = await deploy();
      await f.collateral.mint(await f.stranger.getAddress(), 10n * ONE);
      await as$(f.collateral, f.stranger).approve(f.agentAddr, 10n * ONE);
      await as$(f.agent, f.stranger).deposit(10n * ONE);
      expect(await f.collateral.balanceOf(f.agentAddr)).to.equal(110n * ONE);
      await expect(as$(f.agent, f.stranger).withdraw(0)).to.be.revertedWithCustomError(f.agent, "NotOwner");
    });

    it("rejects a zero deposit", async () => {
      const f = await deploy();
      await expect(as$(f.agent, f.user).deposit(0)).to.be.revertedWithCustomError(f.agent, "ZeroAmount");
    });

    it("reverts a withdrawal when there is nothing to take", async () => {
      const f = await deploy();
      await as$(f.agent, f.user).withdraw(0);
      await expect(as$(f.agent, f.user).withdraw(0)).to.be.revertedWithCustomError(f.agent, "NothingToWithdraw");
    });
  });
});

describe("VaneFactory", () => {
  async function deployFactory() {
    const [deployer, user, other, operator] = await ethers.getSigners();
    const collateral = await (await ethers.getContractFactory("MockCollateral")).deploy();
    await collateral.waitForDeployment();
    const factory = await (await ethers.getContractFactory("VaneFactory")).deploy(
      await collateral.getAddress(),
      await operator.getAddress(),
    );
    await factory.waitForDeployment();
    return { deployer, user, other, operator, collateral, factory };
  }

  it("gives each user their own agent, owned by them", async () => {
    const { user, other, factory } = await deployFactory();
    await as$(factory, user).createAgent();
    await as$(factory, other).createAgent();

    const a = await factory.agentOf(await user.getAddress());
    const b = await factory.agentOf(await other.getAddress());
    expect(a).to.not.equal(b);
    expect(await factory.agentCount()).to.equal(2n);

    const agentA = await ethers.getContractAt("VaneAgent", a);
    expect(await agentA.owner()).to.equal(await user.getAddress());
  });

  it("refuses a second agent, so funds in the first are never orphaned", async () => {
    const { user, factory } = await deployFactory();
    await as$(factory, user).createAgent();
    await expect(as$(factory, user).createAgent()).to.be.revertedWithCustomError(factory, "AgentAlreadyExists");
  });

  it("hands new agents the default operator, which the owner can change", async () => {
    const { user, operator, factory } = await deployFactory();
    await as$(factory, user).createAgent();
    const agent = await ethers.getContractAt("VaneAgent", await factory.agentOf(await user.getAddress()));
    expect(await agent.operator()).to.equal(await operator.getAddress());
    await as$(agent, user).setOperator(ethers.ZeroAddress);
    expect(await agent.operator()).to.equal(ethers.ZeroAddress);
  });
});
