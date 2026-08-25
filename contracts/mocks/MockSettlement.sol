// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice Minimal ERC-6909-style singleton for outcome positions.
contract MockOutcomeToken {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isOperator;

    function mint(address to, uint256 id, uint256 amount) external {
        balanceOf[to][id] += amount;
    }

    function burnFrom(address from, uint256 id, uint256 amount) external {
        require(balanceOf[from][id] >= amount, "balance");
        balanceOf[from][id] -= amount;
    }

    function setOperator(address spender, bool approved) external returns (bool) {
        isOperator[msg.sender][spender] = approved;
        return true;
    }
}

/// @notice One settled binary market.
/// @dev Mirrors settlement v3: a payout VECTOR, with no `winningOutcome()` at all, because
///      the real contract removed it and reverts when it is called.
contract MockBinaryMarket {
    address public outcomeToken;
    uint256 public yesId;
    uint256 public noId;

    bool public isResolved;
    bool public isVoided;
    uint256[] internal _payouts;

    constructor(address outcomeToken_, uint256 yesId_, uint256 noId_) {
        outcomeToken = outcomeToken_;
        yesId = yesId_;
        noId = noId_;
    }

    function resolveTo(uint8 winner) external {
        isResolved = true;
        isVoided = false;
        delete _payouts;
        _payouts.push(winner == 0 ? 1 : 0);
        _payouts.push(winner == 1 ? 1 : 0);
    }

    function voidIt() external {
        isVoided = true;
        isResolved = false;
        delete _payouts;
        _payouts.push(1);
        _payouts.push(1);
    }

    function payoutNumerators() external view returns (uint256[] memory) {
        return _payouts;
    }
}

/// @notice Stand-in for BinaryMarketsModule.
/// @dev Placed at the real module address with hardhat_setCode, because the agent pins that
///      address as a constant (it is identical on Shannon and mainnet).
contract MockMarketsModule {
    address public outcomeToken;
    address public collateral;
    bool public rejectEverything;

    uint256 public redeemedTotal;

    function configure(address outcomeToken_, address collateral_) external {
        outcomeToken = outcomeToken_;
        collateral = collateral_;
    }

    function setRejectEverything(bool v) external {
        rejectEverything = v;
    }

    function redeem(uint32, bytes32, bytes32, uint8, uint256 amount) external {
        require(!rejectEverything, "module rejected");
        // The module pulls the position from the caller, so it must be an operator.
        (bool okOp, bytes memory opData) = outcomeToken.call(
            abi.encodeWithSignature("isOperator(address,address)", msg.sender, address(this))
        );
        require(okOp && abi.decode(opData, (bool)), "not an operator on the outcome token");

        redeemedTotal += amount;
        // A winning contract pays out one unit of collateral each.
        (bool ok,) = collateral.call(abi.encodeWithSignature("transfer(address,uint256)", msg.sender, amount));
        require(ok, "payout failed");
    }
}
