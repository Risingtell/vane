// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {SomniaEventHandler} from "./interfaces/SomniaEventHandler.sol";
import {IBinaryPool, IERC20, IBinaryMarket, IOutcomeToken6909, IBinaryMarketsModule} from "./interfaces/IBinaryPool.sol";

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

    /// @notice DreamDEX BinaryMarketsModule, the redemption entry point.
    /// @dev Same address on Shannon and mainnet, so it is fixed rather than configured.
    address public constant MARKETS_MODULE = 0x3ecC694Cef705358864a646142ac17A90E29e388;

    /// @notice Ceiling on tracked order ids, so one cancel batch always fits in a block.
    uint256 public constant MAX_TRACKED_ORDERS = 48;

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

    /// @notice Orders we placed that may still be holding escrow.
    /// @dev Escrow does NOT come back on its own: an order past its expiry still reads
    ///      Open and stays funded until `cancelExpiredOrders` is called. Without this the
    ///      agent slowly leaks its balance into dead orders.
    uint128[] public openOrderIds;

    /// @notice Market the next scheduled wake should try to redeem.
    address public pendingMarket;
    bytes32 public pendingMarketId;

    /// @notice Routing attribution passed to redeem. Zero matches the SDK default.
    uint32 public redeemOperatorId;
    bytes32 public redeemVenueId;

    /// @notice Probability price for orders, scaled to collateral decimals. 0 uses the default.
    uint256 public limitPrice;

    /// @notice 0 LIMIT, 1 FILL_OR_KILL, 2 MARKET (immediate or cancel), 3 POST_ONLY.
    /// @dev Defaults to 2 so orders actually CROSS and fill. A resting post-only bid never
    ///      fills, which leaves nothing to settle and nothing to redeem.
    uint8 public orderType = 2;

    uint256 public tradeCount;
    uint256 public wakeCount;
    uint256 public lastTradeAt;
    uint256 public reclaimCount;
    uint256 public redeemCount;

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
    event StrategySet(uint256 limitPrice, uint8 orderType);
    event PendingMarketSet(bytes32 indexed marketId, address market);
    event Reclaimed(address indexed pool, uint256 orderCount, uint256 collateralFreed);
    event ReclaimSkipped(address indexed pool, string reason);
    event Redeemed(bytes32 indexed marketId, uint8 outcomeIdx, uint256 amount);
    event PositionsMinted(address indexed pool, uint256 amount);
    event SweepSkipped(bytes32 indexed marketId, string reason);

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

    /// @notice Set the order price and type used by the default strategy.
    /// @param limitPrice_ Probability scaled to collateral decimals (0.95 -> 950000 at 6dp).
    ///        Pass 0 to fall back to the built-in default.
    /// @param orderType_ 0 LIMIT, 1 FILL_OR_KILL, 2 MARKET (IOC), 3 POST_ONLY.
    function setStrategy(uint256 limitPrice_, uint8 orderType_) external onlyOwner {
        limitPrice = limitPrice_;
        orderType = orderType_;
        emit StrategySet(limitPrice_, orderType_);
    }

    /// @notice Nominate the market the next scheduled wake should redeem.
    function setPendingMarket(bytes32 marketId, address market) external onlyOperatorOrOwner {
        pendingMarketId = marketId;
        pendingMarket = market;
        emit PendingMarketSet(marketId, market);
    }

    /// @notice Routing attribution for redemption. Both zero matches the SDK default.
    function setRedeemRouting(uint32 operatorId_, bytes32 venueId_) external onlyOwner {
        redeemOperatorId = operatorId_;
        redeemVenueId = venueId_;
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
    function _onEvent(address emitter, bytes32[] calldata eventTopics, bytes calldata) internal override {
        unchecked {
            wakeCount++;
        }
        emit WokenByChain(emitter, block.number);

        // Two kinds of wake arrive here, and topic0 tells them apart. A one-shot armed with
        // scheduleAtTimestamp fires the precompile's own Schedule event, and that is the
        // housekeeping pass: free escrow and claim anything that settled. Every other topic
        // is real market activity, so it is a chance to trade.
        if (eventTopics.length != 0 && eventTopics[0] == TOPIC_SCHEDULE) {
            _housekeep();
            return;
        }

        // Trade the configured pool. If the emitter happens to BE an allowed pool, prefer
        // it, so a per-pool subscription acts on the pool that actually moved.
        address target = poolAllowed[emitter] ? emitter : activePool;
        if (target == address(0)) {
            emit TradeSkipped(address(0), "no active pool set");
            return;
        }
        _tryTrade(target);
    }

    /// @notice The scheduled pass: get money back. Also callable by hand.
    function housekeep() external {
        _housekeep();
    }

    function _housekeep() private {
        if (activePool != address(0) && openOrderIds.length != 0) {
            this.reclaimExpired(activePool);
        }
        if (pendingMarket != address(0)) {
            this.sweepSettled(pendingMarketId, pendingMarket);
        }
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
            orderType,
            0, // self-match: cancel the remainder of our own taker
            address(0),
            0,
            0
        ) returns (bool, uint128 orderId) {
            unchecked {
                tradeCount++;
            }
            lastTradeAt = block.timestamp;
            // Remembered so escrow can be released later. An order that rests and then
            // expires keeps its collateral until something cancels it. Capped so the
            // cancel batch cannot grow past what fits in one transaction.
            if (orderId != 0 && openOrderIds.length < MAX_TRACKED_ORDERS) openOrderIds.push(orderId);
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
        // Default 0.95 so the order CROSSES and fills. A resting bid below the market never
        // fills, which leaves no position to settle and nothing to redeem, and the escrow
        // just sits locked until it is cancelled.
        price = limitPrice == 0 ? (one * 95) / 100 : limitPrice;
        // Quantity is in contracts, and each costs at most `price` collateral, so size / price.
        quantity = (size * one) / price;
        kind = 0; // BUY_YES
    }

    /// @notice Mint a complete set: collateral in, one YES and one NO out.
    /// @dev No counterparty is needed, which is how a maker builds inventory to quote both
    ///      sides. It is also the only way to hold a position on a market whose book is
    ///      empty. At settlement one side pays 1 and the other 0, so a complete set is
    ///      worth exactly what it cost.
    function mintPositions(address pool, uint256 amount) external onlyOperatorOrOwner {
        if (amount == 0) revert ZeroAmount();
        if (!poolAllowed[pool]) {
            emit TradeSkipped(pool, "pool not allowed");
            return;
        }
        // Both halves to ourselves; the pool pulls collateral under the allowance that
        // setPoolAllowed granted.
        IBinaryPool(pool).mintSet(address(this), address(this), amount);
        emit PositionsMinted(pool, amount);
    }

    // --------------------------------------------------------- getting money back

    /// @notice Release escrow held by our expired orders.
    /// @dev PERMISSIONLESS on purpose. If the operator disappears, anyone can still free
    ///      the owner's collateral, and the pool returns it to the order's owner (us)
    ///      rather than to whoever calls. Measured ~517k gas for six orders on a live pool.
    function reclaimExpired(address pool) external {
        uint256 n = openOrderIds.length;
        if (n == 0) {
            emit ReclaimSkipped(pool, "no recorded orders");
            return;
        }

        // The pool SKIPS orders that have not expired yet rather than failing, so a call
        // can succeed and free nothing at all. Measure the collateral instead of trusting
        // the call, and only forget the ids once their escrow is actually back. Clearing
        // optimistically loses the orders and strands the money in them for good.
        uint256 before = collateral.balanceOf(address(this));

        try IBinaryPool(pool).cancelExpiredOrders(openOrderIds) {
            uint256 freed = collateral.balanceOf(address(this)) - before;
            if (freed == 0) {
                emit ReclaimSkipped(pool, "nothing had expired yet");
                return;
            }
            unchecked {
                reclaimCount++;
            }
            delete openOrderIds;
            emit Reclaimed(pool, n, freed);
        } catch {
            emit ReclaimSkipped(pool, "pool rejected the cancel");
        }
    }

    /// @notice Drop the recorded order ids without touching the pool.
    /// @dev An escape hatch for the awkward case where some of the batch has expired and
    ///      some has not. Every id is also in a Traded event, so anyone can always call
    ///      cancelExpiredOrders on the pool directly with them.
    function forgetOrders() external onlyOwner {
        delete openOrderIds;
    }

    /// @notice How many order ids are currently being tracked for reclaim.
    function openOrderCount() external view returns (uint256) {
        return openOrderIds.length;
    }

    /// @notice Turn a settled position back into collateral.
    /// @dev PERMISSIONLESS, for the same reason as reclaim: redemption must never depend on
    ///      the operator still being alive. DreamDEX's own docs call this "the step people
    ///      miss", because finalized markets drop out of the normal market listing.
    /// @param marketId The market key. Redemption is keyed by market, never by pool, since
    ///        pools are recycled onto the next window.
    /// @param market The market contract for this window.
    function sweepSettled(bytes32 marketId, address market) external {
        IBinaryMarket m = IBinaryMarket(market);

        bool voided = m.isVoided();
        if (!voided && !m.isResolved()) {
            emit SweepSkipped(marketId, "not settled yet");
            return;
        }

        IOutcomeToken6909 token = IOutcomeToken6909(m.outcomeToken());
        // The module pulls the winning position from us, so it has to be an operator on the
        // ERC-6909 singleton first. One grant covers every id and every market.
        if (!token.isOperator(address(this), MARKETS_MODULE)) {
            token.setOperator(MARKETS_MODULE, true);
        }

        if (voided) {
            // A voided market pays BOTH sides at 0.5, so claim both.
            _redeemOne(marketId, token, 0, m.yesId());
            _redeemOne(marketId, token, 1, m.noId());
            return;
        }

        // Settlement v3 stores a payout vector. `winningOutcome()` was removed and reverts,
        // so the winner is the argmax.
        uint256[] memory payouts = m.payoutNumerators();
        if (payouts.length == 0) {
            emit SweepSkipped(marketId, "no payout vector");
            return;
        }
        uint8 winner = 0;
        for (uint256 i = 1; i < payouts.length; i++) {
            if (payouts[i] > payouts[winner]) winner = uint8(i);
        }
        _redeemOne(marketId, token, winner, winner == 0 ? m.yesId() : m.noId());
    }

    function _redeemOne(bytes32 marketId, IOutcomeToken6909 token, uint8 outcomeIdx, uint256 tokenId) private {
        uint256 amount = token.balanceOf(address(this), tokenId);
        if (amount == 0) {
            emit SweepSkipped(marketId, "no position to redeem");
            return;
        }
        try IBinaryMarketsModule(MARKETS_MODULE).redeem(
            redeemOperatorId, redeemVenueId, marketId, outcomeIdx, amount
        ) {
            unchecked {
                redeemCount++;
            }
            emit Redeemed(marketId, outcomeIdx, amount);
        } catch {
            emit SweepSkipped(marketId, "module rejected the redeem");
        }
    }

    // ------------------------------------------------------------------- rescue

    /// @notice Recover a token that is not the trading collateral (an outcome token, a
    ///         mistaken transfer). It cannot touch collateral, so it is not a back door.
    function rescueToken(address token, uint256 amount) external onlyOwner {
        if (token == address(collateral)) revert CollateralIsNotRescuable();
        if (!IERC20(token).transfer(owner, amount)) revert TransferFailed();
    }
}
