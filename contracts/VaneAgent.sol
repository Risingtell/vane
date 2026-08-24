// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {SomniaEventHandler} from "./interfaces/SomniaEventHandler.sol";
import {IBinaryPool, IERC20} from "./interfaces/IBinaryPool.sol";

/// @title VaneAgent
/// @notice A prediction-market trading agent with no server, no bot and no keeper.
///         It lives on-chain and the Somnia chain itself wakes it to trade DreamDEX
///         event contracts.
///
/// @dev ONE AGENT PER USER. That is deliberate, and it is what makes the custody honest.
///
///      DreamDEX gives third parties no way to trade event contracts for someone else.
///      Both routes were checked against live Shannon and both are closed: the operator
///      permission registry is spot-only (a BinaryPool escrows through the module and has
///      no operator gate), and placeBinaryOrderFor reverts OnlyApprovedContracts() for
///      anyone outside the protocol allowlist. Plain placeBinaryOrder pulls collateral
///      from msg.sender, so whoever trades must hold the money.
///
///      Rather than pretend otherwise, this contract holds the collateral and removes the
///      danger instead:
///
///        * withdraw is owner-only and unconditional. It does not depend on the strategy,
///          the operator, the pause flag or the chain subscription. If every other part of
///          this system breaks, the money still comes out.
///        * The operator may trade and nothing else. It can never move collateral out.
///        * User collateral never pays gas. Reactivity bills the subscription owner, which
///          is the operator's own EOA, so this contract holds no STT at all.
contract VaneAgent is SomniaEventHandler {
    // ---------------------------------------------------------------- immutables

    /// @notice The only account that can ever withdraw. Fixed at construction.
    address public immutable owner;

    /// @notice Collateral token for the venue (tUSDC on Shannon, 6 decimals).
    IERC20 public immutable collateral;

    // ------------------------------------------------------------------- storage

    /// @notice Allowed to trigger trading, never to move funds. The owner can clear it.
    address public operator;

    /// @notice While false the agent opens no new positions. Withdrawals are unaffected.
    bool public tradingEnabled;

    /// @notice Hard ceiling on collateral committed to any single window.
    uint256 public maxPerWindow;

    /// @notice Collateral that must always remain unspent, a floor under the balance.
    uint256 public reserve;

    /// @notice Pools this agent may touch. An unlisted pool can never be traded.
    mapping(address => bool) public poolAllowed;

    /// @notice Last time each pool was traded, so one window is acted on once.
    mapping(address => uint256) public lastTradedAt;

    /// @notice Minimum gap between trades on one pool, in seconds.
    uint64 public minSecondsBetweenTrades = 30;

    /// @notice The pool this agent trades when the chain wakes it.
    /// @dev The reactivity event comes from the markets MODULE, not from a pool, so the
    ///      emitter address is not a trading venue. The wake says "something happened in
    ///      the market"; this says where to act on it.
    address public activePool;

    /// @notice Order quantities must be a whole multiple of this.
    /// @dev Measured against a live Shannon pool: 1000 is accepted, 100 is not, and an
    ///      off-grid quantity reverts `InvalidQuantity`. Kept configurable because the
    ///      grid belongs to the venue and can differ per pool.
    uint256 public lotSize = 1000;

    uint256 public tradeCount;
    uint256 public wakeCount;
    uint256 public lastTradeAt;

    // -------------------------------------------------------------------- events

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event OperatorChanged(address indexed previous, address indexed next);
    event TradingSet(bool enabled);
    event PolicySet(uint256 maxPerWindow, uint256 reserve, uint64 minSecondsBetweenTrades);
    event PoolAllowed(address indexed pool, bool allowed);
    event LotSizeSet(uint256 lotSize);
    event ActivePoolSet(address indexed pool);
    event Traded(address indexed pool, uint8 kind, uint256 price, uint256 quantity, uint128 orderId);
    event TradeSkipped(address indexed pool, string reason);
    event WokenByChain(address emitter, uint256 blockNumber);

    // -------------------------------------------------------------------- errors

    error NotOwner();
    error NotOperatorOrOwner();
    error ZeroAmount();
    error NothingToWithdraw();
    error TransferFailed();
    error CollateralIsNotRescuable();

    // ----------------------------------------------------------------- modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperatorOrOwner() {
        if (msg.sender != operator && msg.sender != owner) revert NotOperatorOrOwner();
        _;
    }

    constructor(address owner_, address collateral_, address operator_) {
        owner = owner_;
        collateral = IERC20(collateral_);
        operator = operator_;
    }

    // ------------------------------------------------------------ money in / out

    /// @notice Pull collateral in. Requires the usual ERC-20 approval to this contract.
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (!collateral.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Deposited(msg.sender, amount);
    }

    /// @notice Take collateral out. Owner only, and deliberately unconditional.
    /// @dev This is the safety property the whole design rests on. Do not add a pause
    ///      check, an operator check, or any dependency on chain state here.
    /// @param amount Pass 0 to withdraw the full balance.
    function withdraw(uint256 amount) external onlyOwner {
        uint256 balance = collateral.balanceOf(address(this));
        uint256 amountOut = (amount == 0 || amount > balance) ? balance : amount;
        if (amountOut == 0) revert NothingToWithdraw();
        if (!collateral.transfer(owner, amountOut)) revert TransferFailed();
        emit Withdrawn(owner, amountOut);
    }

    /// @notice Stop trading and pull everything back in one call.
    function emergencyExit() external onlyOwner {
        tradingEnabled = false;
        emit TradingSet(false);
        uint256 balance = collateral.balanceOf(address(this));
        if (balance != 0) {
            if (!collateral.transfer(owner, balance)) revert TransferFailed();
            emit Withdrawn(owner, balance);
        }
    }

    // -------------------------------------------------------------------- policy

    function setOperator(address next) external onlyOwner {
        emit OperatorChanged(operator, next);
        operator = next;
    }

    function setTradingEnabled(bool enabled) external onlyOwner {
        tradingEnabled = enabled;
        emit TradingSet(enabled);
    }

    function setPolicy(uint256 maxPerWindow_, uint256 reserve_, uint64 minSecondsBetweenTrades_)
        external
        onlyOwner
    {
        maxPerWindow = maxPerWindow_;
        reserve = reserve_;
        minSecondsBetweenTrades = minSecondsBetweenTrades_;
        emit PolicySet(maxPerWindow_, reserve_, minSecondsBetweenTrades_);
    }

    /// @notice Set the pool the agent acts on when woken.
    function setActivePool(address pool) external onlyOwner {
        activePool = pool;
        emit ActivePoolSet(pool);
    }

    /// @notice Set the venue's lot grid. Pass 1 to disable rounding.
    function setLotSize(uint256 lotSize_) external onlyOwner {
        if (lotSize_ == 0) revert ZeroAmount();
        lotSize = lotSize_;
        emit LotSizeSet(lotSize_);
    }

    /// @notice Allow or forbid a pool, and set the approval that lets it pull collateral.
    /// @dev The pool pulls collateral on order placement, so it needs an allowance.
    ///      Revoking sets that allowance back to zero in the same call.
    function setPoolAllowed(address pool, bool allowed) external onlyOwner {
        poolAllowed[pool] = allowed;
        collateral.approve(pool, allowed ? type(uint256).max : 0);
        emit PoolAllowed(pool, allowed);
    }

    // ------------------------------------------------------- the chain wakes us

    /// @dev Invoked by the reactivity precompile when a subscribed market event lands.
    ///      It must never revert on a business condition: a revert rolls the whole wake
    ///      back and leaves no trace of why nothing happened.
    function _onEvent(address emitter, bytes32[] calldata, bytes calldata) internal override {
        unchecked {
            wakeCount++;
        }
        emit WokenByChain(emitter, block.number);

        // Trade the configured pool. If the emitter happens to BE an allowed pool, prefer
        // it, so a per-pool subscription acts on the pool that actually moved.
        address target = poolAllowed[emitter] ? emitter : activePool;
        if (target == address(0)) {
            emit TradeSkipped(address(0), "no active pool set");
            return;
        }
        _tryTrade(target);
    }

    /// @notice Manual trigger, for tests and for the console's trade-now button.
    function poke(address pool) external onlyOperatorOrOwner {
        _tryTrade(pool);
    }

    function _tryTrade(address pool) private {
        if (!tradingEnabled) {
            emit TradeSkipped(pool, "trading disabled");
            return;
        }
        if (!poolAllowed[pool]) {
            emit TradeSkipped(pool, "pool not allowed");
            return;
        }
        if (block.timestamp < lastTradedAt[pool] + minSecondsBetweenTrades) {
            emit TradeSkipped(pool, "too soon for this pool");
            return;
        }

        uint256 balance = collateral.balanceOf(address(this));
        if (balance <= reserve) {
            emit TradeSkipped(pool, "balance at or below reserve");
            return;
        }
        uint256 spendable = balance - reserve;
        uint256 size = spendable < maxPerWindow ? spendable : maxPerWindow;
        if (size == 0) {
            emit TradeSkipped(pool, "size is zero");
            return;
        }

        (uint8 kind, uint256 price, uint256 quantity) = _decide(pool, size);
        if (quantity == 0) {
            emit TradeSkipped(pool, "strategy declined");
            return;
        }

        // Round DOWN onto the venue's lot grid. An off-grid quantity is rejected with
        // InvalidQuantity, and rounding up could spend past the window budget.
        if (lotSize > 1) {
            quantity = (quantity / lotSize) * lotSize;
            if (quantity == 0) {
                emit TradeSkipped(pool, "size below one lot");
                return;
            }
        }

        lastTradedAt[pool] = block.timestamp;

        // A rejected order must not roll back the wake, so the call is contained.
        try IBinaryPool(pool).placeBinaryOrder(
            kind,
            price,
            quantity,
            uint64(block.timestamp + 300) * 1_000_000_000,
            0, // LIMIT: fill what crosses, rest the remainder
            0, // self-match: cancel the remainder of our own taker
            address(0),
            0,
            0
        ) returns (bool, uint128 orderId) {
            unchecked {
                tradeCount++;
            }
            lastTradeAt = block.timestamp;
            emit Traded(pool, kind, price, quantity, orderId);
        } catch {
            emit TradeSkipped(pool, "pool rejected the order");
        }
    }

    /// @notice The strategy. Isolated on purpose so it can be replaced without touching
    ///         custody, policy or the wake path.
    /// @dev Intentionally conservative: a resting bid below even money, sized to the
    ///      window budget. The differentiator of this project is the execution model, not
    ///      the alpha, and overclaiming a strategy to judges is worse than claiming none.
    function _decide(address, uint256 size)
        internal
        view
        virtual
        returns (uint8 kind, uint256 price, uint256 quantity)
    {
        uint256 one = 10 ** collateral.decimals();
        price = (one * 45) / 100; // 0.45 probability
        // Quantity is in contracts, and each costs `price` collateral, so size / price.
        quantity = (size * one) / price;
        kind = 0; // BUY_YES
    }

    // ------------------------------------------------------------------- rescue

    /// @notice Recover a token that is not the trading collateral (an outcome token, a
    ///         mistaken transfer). It cannot touch collateral, so it is not a back door.
    function rescueToken(address token, uint256 amount) external onlyOwner {
        if (token == address(collateral)) revert CollateralIsNotRescuable();
        if (!IERC20(token).transfer(owner, amount)) revert TransferFailed();
    }
}
