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

    /// @dev Collateral in, one YES and one NO out. Callable with both recipients set to self.
    function mintSet(address yesTo, address noTo, uint256 amount) external;

    function burnSet(uint256 amount) external;
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
