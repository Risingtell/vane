// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ISomniaReactivity} from "../interfaces/ISomniaReactivity.sol";

/// @notice Test double for the Somnia reactivity precompile, so handler logic can be
///         exercised on a local Hardhat network where 0x0100 does not exist.
/// @dev Deployed, then its runtime code is placed at 0x0100 with hardhat_setCode.
contract MockReactivity is ISomniaReactivity {
    uint256 public nextId = 1;

    mapping(uint256 => SubscriptionData) internal _subs;
    mapping(uint256 => address) internal _owners;

    function subscribe(SubscriptionData calldata subscriptionData) external returns (uint256 subscriptionId) {
        require(subscriptionData.handlerContractAddress != address(0), "handler required");
        require(subscriptionData.gasLimit != 0 && subscriptionData.gasLimit <= 200_000_000, "bad gas limit");
        subscriptionId = nextId++;
        _subs[subscriptionId] = subscriptionData;
        _owners[subscriptionId] = msg.sender;
        emit SubscriptionCreated(subscriptionId, msg.sender, subscriptionData);
    }

    function unsubscribe(uint256 subscriptionId) external {
        require(_owners[subscriptionId] != address(0), "unknown subscription");
        address owner = _owners[subscriptionId];
        delete _subs[subscriptionId];
        delete _owners[subscriptionId];
        emit SubscriptionRemoved(subscriptionId, owner);
    }

    function getSubscriptionInfo(uint256 subscriptionId)
        external
        view
        returns (SubscriptionData memory subscriptionData, address owner)
    {
        return (_subs[subscriptionId], _owners[subscriptionId]);
    }
}
