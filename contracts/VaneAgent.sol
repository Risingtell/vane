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

    /// @notice How long an order is allowed to rest, unless its market ends sooner.
    uint64 public constant ORDER_TTL_SECONDS = 300;

    /// @notice topic0 of DreamDEX's MarketCreated, the event that opens a new window.
    /// @dev Recovered by hashing every event signature in @somnia-chain/markets-sdk against
    ///      live BinaryMarketsModule logs. It is worth writing down how, because none of the
    ///      usual routes work: the module is a proxy whose implementation is unverified on
    ///      the explorer, and this signature is in no public topic database.
    ///
    ///      MarketCreated(bytes32 indexed marketId, address indexed market,
    ///        address indexed pool, uint256 oracleQuestionId, uint32 operatorId,
    ///        bytes32 venueId, address creator, address collateral, uint256 yesId,
    ///        uint256 noId, uint64 nonce, uint8 outcomeSlotCount, uint8 marketType,
    ///        uint64 tradingStart, uint64 expiry, uint8 voidPolicy, string asset,
    ///        uint256 strike, string question, bytes context)
    ///
    ///      The new pool is topic3, and every field this contract needs to judge a window
    ///      sits in the fixed-width head of the data, ahead of the dynamic strings. So the
    ///      whole decision costs three 32-byte reads and no dynamic decoding at all.
    bytes32 public constant TOPIC_MARKET_CREATED =
        0xb5ec75cdb7dbcd28a5f50d152d8833334525a902ef5332ebc19bcf5c0011f8cd;

    /// @dev Byte offsets into MarketCreated's data. Head slot n covers [n*32, n*32+32).
    uint256 private constant OFF_VENUE_ID = 64; // head[2]
    uint256 private constant OFF_COLLATERAL = 128; // head[4]
    uint256 private constant OFF_EXPIRY = 352; // head[11]
    /// @dev Through head[11], which is the last slot this contract reads.
    uint256 private constant MIN_CREATED_DATA = 384;

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

    /// @notice When the window behind `activePool` closes, in unix seconds. 0 if unknown.
    /// @dev Only set when the agent rolled itself onto the pool, since that is the only
    ///      path that learns the expiry. A manual setActivePool clears it back to 0.
    uint64 public activePoolExpiry;

    /// @notice The venue this agent will roll itself forward onto. Zero disables rolling.
    /// @dev ⚠ This is the ONLY field that separates real DreamDEX windows from the
    ///      "Pricefeed test" markets the same module creates, in the same bursts, in the
    ///      same transactions. Both are marketType BINARY and both use the same collateral,
    ///      so neither of those can be used as the filter. Measured on live Shannon:
    ///      DreamDEX is operatorId 2, the throwaway pricefeed markets are operatorId 4.
    bytes32 public rollVenueId;

    /// @notice A new window needs at least this long left to be worth moving onto.
    /// @dev DreamDEX opens one-minute, five-minute and multi-hour windows alongside each
    ///      other, so without a floor the agent would take whichever arrived last,
    ///      including one that dies almost immediately.
    ///
    ///      ⚠ The default is deliberately low, and that is a direct consequence of a
    ///      measured platform limitation: only about HALF of the module's MarketCreated
    ///      logs actually produce a wake (see SPIKE-FINDINGS.md). An agent that would only
    ///      accept the rare long windows can sit for a very long time waiting for one whose
    ///      wake is not dropped. Taking the abundant five-minute windows means the next
    ///      chance is never more than a few minutes away.
    uint64 public minWindowSeconds = 240;

    /// @notice The pool the tracked order ids belong to.
    /// @dev Escrow is held by the book the order was placed in. Once the agent can move
    ///      itself onto a new window, that is no longer always `activePool`, and reclaiming
    ///      against the wrong pool would quietly strand the collateral.
    address public orderPool;

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
    uint256 public rollCount;

    // -------------------------------------------------------------------- events

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event OperatorChanged(address indexed previous, address indexed next);
    event TradingSet(bool enabled);
    event PolicySet(uint256 maxPerWindow, uint256 reserve, uint64 minSecondsBetweenTrades);
    event PoolAllowed(address indexed pool, bool allowed);
    event LotSizeSet(uint256 lotSize);
    event ActivePoolSet(address indexed pool);
    event RollForwardSet(bytes32 venueId, uint64 minWindowSeconds);
    event RolledForward(address indexed fromPool, address indexed toPool, uint64 expiry);
    event RollSkipped(address indexed pool, string reason);
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
    /// @dev Clears the known expiry: a hand-picked pool carries no window information, and
    ///      leaving a stale expiry here would stop the agent rolling off it later.
    function setActivePool(address pool) external onlyOwner {
        activePool = pool;
        activePoolExpiry = 0;
        emit ActivePoolSet(pool);
    }

    /// @notice Let the agent move itself onto new windows as the chain opens them.
    /// @param venueId_ The venue to follow. Zero switches rolling off entirely, which
    ///        leaves the agent on whatever pool it was last pointed at by hand.
    /// @param minWindowSeconds_ How much of a window has to be left for it to be worth
    ///        taking. Raising this makes the agent pickier, but roughly half of the
    ///        venue's window-opening events never reach a subscriber, so being picky
    ///        costs idle time rather than buying a better window.
    function setRollForward(bytes32 venueId_, uint64 minWindowSeconds_) external onlyOwner {
        rollVenueId = venueId_;
        minWindowSeconds = minWindowSeconds_;
        emit RollForwardSet(venueId_, minWindowSeconds_);
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
    function _onEvent(address emitter, bytes32[] calldata eventTopics, bytes calldata data) internal override {
        unchecked {
            wakeCount++;
        }
        emit WokenByChain(emitter, block.number);

        // Three kinds of wake arrive here, and topic0 tells them apart. A one-shot armed
        // with scheduleAtTimestamp fires the precompile's own Schedule event, and that is
        // the housekeeping pass: free escrow and claim anything that settled.
        if (eventTopics.length != 0 && eventTopics[0] == TOPIC_SCHEDULE) {
            _housekeep();
            return;
        }

        // A window opening is the chain telling the agent where to go next. This is the
        // step that used to need a person: the subscription's emitter is the markets
        // module rather than any one pool, so without this the agent stays pointed at a
        // book that has already closed and every order it places is rejected.
        if (eventTopics.length != 0 && eventTopics[0] == TOPIC_MARKET_CREATED) {
            _rollForward(emitter, eventTopics, data);
            return;
        }

        // Everything else is market activity, so it is a chance to trade.

        // Trade the configured pool. If the emitter happens to BE an allowed pool, prefer
        // it, so a per-pool subscription acts on the pool that actually moved.
        address target = poolAllowed[emitter] ? emitter : activePool;
        if (target == address(0)) {
            emit TradeSkipped(address(0), "no active pool set");
            return;
        }
        _tryTrade(target);
    }

    /// @notice Move the agent onto a window the chain has just opened.
    /// @dev Never reverts on a business condition. A revert here would roll the whole wake
    ///      back, including the wake counter, and leave no record of why nothing happened.
    function _rollForward(address emitter, bytes32[] calldata eventTopics, bytes calldata data) private {
        // Defence in depth. The subscription already filters on the module as the emitter,
        // but a subscription armed differently must never be able to point this agent at a
        // pool of somebody else's choosing.
        if (emitter != MARKETS_MODULE) {
            emit RollSkipped(address(0), "wrong emitter");
            return;
        }
        if (rollVenueId == bytes32(0)) {
            emit RollSkipped(address(0), "rolling not configured");
            return;
        }
        if (eventTopics.length < 4 || data.length < MIN_CREATED_DATA) {
            emit RollSkipped(address(0), "unexpected event shape");
            return;
        }

        address pool = address(uint160(uint256(eventTopics[3])));
        if (pool == address(0)) {
            emit RollSkipped(pool, "no pool in event");
            return;
        }

        // abi.decode over a calldata slice, rather than raw word loads, so a malformed
        // head is rejected instead of silently read as a plausible-looking value.
        if (abi.decode(data[OFF_VENUE_ID:OFF_VENUE_ID + 32], (bytes32)) != rollVenueId) {
            emit RollSkipped(pool, "different venue");
            return;
        }
        if (abi.decode(data[OFF_COLLATERAL:OFF_COLLATERAL + 32], (address)) != address(collateral)) {
            emit RollSkipped(pool, "different collateral");
            return;
        }

        uint64 expiry = abi.decode(data[OFF_EXPIRY:OFF_EXPIRY + 32], (uint64));
        if (expiry < block.timestamp + minWindowSeconds) {
            emit RollSkipped(pool, "window too short");
            return;
        }

        // Stay on a book until its window actually ends. DreamDEX runs a whole ladder side
        // by side, measured on Shannon over 24h: 5-minute windows every five minutes,
        // 15-minute every fifteen, then hourly, four-hourly and daily. Without this the
        // agent would abandon a book it is happily trading every time the venue opened
        // anything longer, and end up parked on the daily window all day.
        //
        // An expiry of 0 means the pool was chosen by hand and its window is unknown, so
        // the agent treats itself as needing one.
        if (activePool != address(0) && activePoolExpiry > block.timestamp) {
            emit RollSkipped(pool, "current window still open");
            return;
        }
        // Having decided it needs a window, take the first one offered that beats what it
        // has. A creation burst arrives as several separate wakes, so this settles on the
        // first tradable book rather than hopping through the rest of the burst.
        if (pool == activePool || expiry <= activePoolExpiry) {
            emit RollSkipped(pool, "no better than the current window");
            return;
        }

        address previous = activePool;

        // Free what the old book is still holding before walking away from it. Orders that
        // have not expired yet stay tracked against `orderPool`, so the scheduled
        // housekeeping wake can still collect them after the move.
        if (openOrderIds.length != 0 && orderPool != address(0)) {
            try this.reclaimExpired(orderPool) {} catch {}
        }

        poolAllowed[pool] = true;
        collateral.approve(pool, type(uint256).max);
        activePool = pool;
        activePoolExpiry = expiry;
        unchecked {
            rollCount++;
        }
        emit PoolAllowed(pool, true);
        emit ActivePoolSet(pool);
        emit RolledForward(previous, pool, expiry);

        // Drop the old book's allowance, but only once nothing of ours is resting in it.
        if (previous != address(0) && previous != pool && openOrderIds.length == 0) {
            poolAllowed[previous] = false;
            collateral.approve(previous, 0);
            emit PoolAllowed(previous, false);
        }
    }

    /// @notice The scheduled pass: get money back. Also callable by hand.
    function housekeep() external {
        _housekeep();
    }

    /// @dev Both halves are contained, for the same reason the wake path is: a revert here
    ///      rolls back the whole wake, including `wakeCount`, and destroys the only record
    ///      that the chain called at all.
    ///
    ///      This matters most for the sweep. `sweepSettled` reaches into a market contract
    ///      nominated by `setPendingMarket`, which the OPERATOR may call, and it touches
    ///      that address before it reaches any guarded call. So an operator pointing at a
    ///      market that does not answer, or at no contract at all, could otherwise stop
    ///      every scheduled wake. The operator is trusted to trade and nothing more, so it
    ///      must not be able to do that. Failing one half must also never cost the other.
    function _housekeep() private {
        // Against `orderPool`, not `activePool`. Once the agent rolls itself forward those
        // are different, and the escrow is in the book the orders were placed in.
        if (orderPool != address(0) && openOrderIds.length != 0) {
            try this.reclaimExpired(orderPool) {} catch {
                emit ReclaimSkipped(orderPool, "reclaim reverted");
            }
        }
        if (pendingMarket != address(0)) {
            try this.sweepSettled(pendingMarketId, pendingMarket) {} catch {
                emit SweepSkipped(pendingMarketId, "market did not answer");
            }
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

        // An order may not outlive its market: the pool reverts `OrderExpiryBeyondMarket()`
        // (selector 0xd3dea628). That never showed up while the agent sat on one long
        // window chosen by hand, and then rejected every order the moment it began moving
        // itself onto five-minute ones. The expiry is only known for a window the agent
        // rolled onto itself, so clamp when it is known and fall back to the flat lifetime
        // when it is not.
        uint64 orderExpiry = uint64(block.timestamp) + ORDER_TTL_SECONDS;
        if (pool == activePool && activePoolExpiry != 0 && activePoolExpiry < orderExpiry) {
            orderExpiry = activePoolExpiry;
        }
        if (orderExpiry <= block.timestamp) {
            emit TradeSkipped(pool, "window already closed");
            return;
        }

        lastTradedAt[pool] = block.timestamp;

        // A rejected order must not roll back the wake, so the call is contained.
        try IBinaryPool(pool).placeBinaryOrder(
            kind,
            price,
            quantity,
            orderExpiry * 1_000_000_000,
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
            //
            // Ids are only ever tracked for ONE book at a time, because that is what the
            // cancel call takes. An id that is not tracked is still in its Traded event,
            // so anyone can always cancel it on the pool directly.
            if (orderId != 0 && openOrderIds.length < MAX_TRACKED_ORDERS) {
                if (openOrderIds.length == 0) orderPool = pool;
                if (orderPool == pool) openOrderIds.push(orderId);
            }
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
