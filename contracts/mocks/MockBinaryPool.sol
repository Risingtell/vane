// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice Stand-in for a DreamDEX BinaryPool.
/// @dev Mirrors the behaviours that matter to the agent, each confirmed on live Shannon:
///      placeBinaryOrder pulls collateral from msg.sender, so an order without an
///      allowance fails the same way it does on chain; and an order may not outlive its
///      market, which the real pool rejects with `OrderExpiryBeyondMarket()`.
contract MockBinaryPool {
    /// @dev Selector 0xd3dea628 on the live venue, recovered from the markets SDK's
    ///      contractErrorsAbi after an order was rejected with no readable reason.
    error OrderExpiryBeyondMarket();

    address public immutable collateral;

    uint128 public nextOrderId = 1;
    bool public rejectEverything;

    /// @notice When this pool's current window ends. Zero disables the check.
    uint256 public marketExpiry;

    struct Order {
        address trader;
        uint8 kind;
        uint256 price;
        uint256 quantity;
        uint256 escrow;
        uint256 expiresAt;
        bool cancelled;
    }

    Order[] public orders;

    constructor(address collateral_) {
        collateral = collateral_;
    }

    function setRejectEverything(bool v) external {
        rejectEverything = v;
    }

    function setMarketExpiry(uint256 v) external {
        marketExpiry = v;
    }

    function orderCount() external view returns (uint256) {
        return orders.length;
    }

    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8,
        uint8,
        address,
        uint96,
        uint64
    ) external payable returns (bool success, uint128 id) {
        // Split out so the nine parameters and the body do not share a stack frame,
        // which overflows the EVM's 16-slot reach without viaIR.
        return _record(kind, price, quantity, expireTimestampNs / 1e9);
    }

    function _record(uint8 kind, uint256 price, uint256 quantity, uint256 expiresAt)
        private
        returns (bool, uint128)
    {
        require(!rejectEverything, "pool rejected");
        // The real venue refuses an order that would outlive the market it trades.
        if (marketExpiry != 0 && expiresAt > marketExpiry) revert OrderExpiryBeyondMarket();

        // Cost of the position, in collateral. Pulled from the caller, exactly as the
        // real pool does.
        _pull((quantity * price) / 1e6);

        orders.push(
            Order({
                trader: msg.sender,
                kind: kind,
                price: price,
                quantity: quantity,
                escrow: (quantity * price) / 1e6,
                expiresAt: expiresAt,
                cancelled: false
            })
        );
        return (true, nextOrderId++);
    }

    function _pull(uint256 cost) private {
        (bool ok, bytes memory data) = collateral.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), cost)
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "collateral pull failed");
    }

    function cancelOrder(uint128) external {}

    /// @notice Release escrow back to each order's own OWNER, not to the caller.
    /// @dev Callable by anyone on a real binary pool, which is what lets a permissionless
    ///      reclaim free an agent's collateral even if its operator is gone.
    function cancelExpiredOrders(uint128[] calldata orderIds) external {
        for (uint256 i = 0; i < orderIds.length; i++) {
            uint256 idx = uint256(orderIds[i]) - 1; // ids start at 1
            if (idx >= orders.length) continue;
            Order storage o = orders[idx];
            if (o.cancelled || o.escrow == 0) continue;
            // The real pool only releases orders that are actually PAST their expiry, and
            // silently skips the rest. A caller that assumes success freed something will
            // forget live orders and strand their collateral.
            if (block.timestamp < o.expiresAt) continue;
            uint256 amount = o.escrow;
            o.escrow = 0;
            o.cancelled = true;
            (bool ok,) = collateral.call(abi.encodeWithSignature("transfer(address,uint256)", o.trader, amount));
            require(ok, "refund failed");
        }
    }

    function mintSet(address, address, uint256) external {}

    function burnSet(uint256) external {}
}
