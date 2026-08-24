// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice Stand-in for a DreamDEX BinaryPool.
/// @dev Mirrors the one behaviour that matters to the agent and that was confirmed on
///      live Shannon: placeBinaryOrder pulls collateral from msg.sender, so an order
///      without an allowance fails the same way it does on chain.
contract MockBinaryPool {
    address public immutable collateral;

    uint128 public nextOrderId = 1;
    bool public rejectEverything;

    struct Order {
        address trader;
        uint8 kind;
        uint256 price;
        uint256 quantity;
    }

    Order[] public orders;

    constructor(address collateral_) {
        collateral = collateral_;
    }

    function setRejectEverything(bool v) external {
        rejectEverything = v;
    }

    function orderCount() external view returns (uint256) {
        return orders.length;
    }

    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64,
        uint8,
        uint8,
        address,
        uint96,
        uint64
    ) external payable returns (bool success, uint128 id) {
        // Split out so the nine parameters and the body do not share a stack frame,
        // which overflows the EVM's 16-slot reach without viaIR.
        return _record(kind, price, quantity);
    }

    function _record(uint8 kind, uint256 price, uint256 quantity) private returns (bool, uint128) {
        require(!rejectEverything, "pool rejected");

        // Cost of the position, in collateral. Pulled from the caller, exactly as the
        // real pool does.
        _pull((quantity * price) / 1e6);

        orders.push(Order({trader: msg.sender, kind: kind, price: price, quantity: quantity}));
        return (true, nextOrderId++);
    }

    function _pull(uint256 cost) private {
        (bool ok, bytes memory data) = collateral.call(
            abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), cost)
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "collateral pull failed");
    }

    function cancelOrder(uint128) external {}

    function mintSet(address, address, uint256) external {}

    function burnSet(uint256) external {}
}
