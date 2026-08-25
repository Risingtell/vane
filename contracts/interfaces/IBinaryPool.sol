// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice The DreamDEX binary (event contract) pool.
/// @dev Signatures taken from the shipped markets-sdk ABI and confirmed against a live
///      Shannon pool: calling `placeBinaryOrder` from an unfunded account reverts
///      `ERC20InsufficientAllowance`, which proves collateral is pulled from msg.sender.
///      `placeBinaryOrderFor` is NOT usable by third parties: it reverts
///      `OnlyApprovedContracts()` (0x3fb0ba2e) regardless of the owner argument.
interface IBinaryPool {
    /// @param kind 0 BUY_YES, 1 SELL_YES, 2 BUY_NO, 3 SELL_NO.
    /// @param price Probability price scaled by the collateral's decimals (0.62 -> 620000 at 6dp).
    /// @param orderType 0 LIMIT, 1 FILL_OR_KILL, 2 MARKET (IOC), 3 POST_ONLY.
    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k,
        uint64 userData
    ) external payable returns (bool success, uint128 id);

    function cancelOrder(uint128 orderId) external;

    /// @notice Release escrow held by orders that are past their expiry.
    /// @dev Callable by ANYONE on a binary pool, and escrow returns to each order's own
    ///      owner. This matters: an order past `expireTimestampNs` still reads
    ///      `status: Open` and keeps its collateral locked until something calls this.
    ///      Measured on a live pool: ~517k gas for six orders.
    function cancelExpiredOrders(uint128[] calldata orderIds) external;

    /// @dev Collateral in, one YES and one NO out. Callable with both recipients set to self.
    function mintSet(address yesTo, address noTo, uint256 amount) external;

    function burnSet(uint256 amount) external;
}

/// @notice One binary market (one window). A pool is recycled onto the next window, so a
///         market is identified by its own address and marketId, never by its pool.
interface IBinaryMarket {
    /// @dev Settlement v3 stores a payout VECTOR. `winningOutcome()` was removed and
    ///      REVERTS on the deployed contract, so the winner is the argmax of this.
    function payoutNumerators() external view returns (uint256[] memory);
    function isResolved() external view returns (bool);
    function isVoided() external view returns (bool);
    function outcomeToken() external view returns (address);
    function yesId() external view returns (uint256);
    function noId() external view returns (uint256);
}

/// @notice The shared ERC-6909 singleton holding every market's YES and NO positions.
interface IOutcomeToken6909 {
    function balanceOf(address owner, uint256 id) external view returns (uint256);
    /// @dev One grant covers every id and every market.
    function setOperator(address spender, bool approved) external returns (bool);
    function isOperator(address owner, address spender) external view returns (bool);
}

/// @notice BinaryMarketsModule, the redemption entry point.
interface IBinaryMarketsModule {
    /// @dev Pulls the winning position from the CALLER, which is why the caller must first
    ///      make this module an operator on the ERC-6909 singleton.
    function redeem(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount)
        external;
}

/// @notice Minimal ERC-20 surface. The testnet collateral (tUSDC) is 6 decimals,
///         mainnet (USDso) is 18, so never hardcode the scale.
interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function decimals() external view returns (uint8);
}
