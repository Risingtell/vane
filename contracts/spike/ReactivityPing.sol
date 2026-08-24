// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {SomniaEventHandler} from "../interfaces/SomniaEventHandler.sol";

/// @notice Day-one spike. Proves the one assumption the whole of Vane rests on:
///         that a deployed contract can be woken by the Somnia chain, do work, and
///         re-arm itself, with no bot, no server and no keeper anywhere.
/// @dev Not product code. If this cannot keep itself alive across several wakes with
///      every local process stopped, the Vane design is dead and we fall back.
contract ReactivityPing is SomniaEventHandler {
    address public immutable owner;

    uint256 public wakeCount;
    uint256 public lastWakeBlock;
    uint256 public lastWakeTimestamp;
    uint256 public currentSubscriptionId;
    uint256 public nextWakeAtMillis;
    /// @dev Id of the persistent event subscription, separate from the one-shot timer.
    uint256 public eventSubscriptionId;

    /// @dev Seconds between self-scheduled wakes.
    uint64 public intervalSeconds = 30;
    /// @dev While false, the handler stops re-arming and the chain forgets us.
    bool public running;

    uint64 public priorityFeePerGas = 1 gwei;
    uint64 public maxFeePerGas = 50 gwei;
    uint64 public wakeGasLimit = 2_000_000;

    event Woke(uint256 indexed count, address emitter, uint256 blockNumber, uint256 timestamp);
    event Armed(uint256 indexed subscriptionId, uint256 forTimestampMillis);
    event ArmedOnEvent(uint256 indexed subscriptionId, address emitter, bytes32 topic0);
    event ReArmFailed(bytes reason);
    event Stopped(uint256 atWakeCount);

    error NotOwner();
    error AlreadyRunning();

    constructor() payable {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Arm the first wake. After this the contract keeps itself going.
    function start(uint64 delaySeconds) external onlyOwner {
        if (running) revert AlreadyRunning();
        running = true;
        _arm(delaySeconds);
    }

    /// @notice Stop re-arming and cancel any pending wake.
    function stop() external onlyOwner {
        running = false;
        if (currentSubscriptionId != 0) {
            // Best effort. A already-fired one-shot may no longer exist.
            try this.externalUnsubscribe(currentSubscriptionId) {} catch {}
            currentSubscriptionId = 0;
        }
        emit Stopped(wakeCount);
    }

    /// @dev Only exists so `stop` can try/catch the precompile call.
    function externalUnsubscribe(uint256 subscriptionId) external {
        if (msg.sender != address(this)) revert NotOwner();
        _unsubscribe(subscriptionId);
    }

    /// @notice Arm a PERSISTENT subscription on a real contract's event.
    /// @dev This is the mode Vane will actually use: no timer, no re-arm, the chain
    ///      wakes us every time the emitter logs a matching event, forever.
    function armOnEvent(address emitter, bytes32 topic0) external onlyOwner returns (uint256 id) {
        id = _subscribeToEvent(emitter, topic0, priorityFeePerGas, maxFeePerGas, wakeGasLimit);
        eventSubscriptionId = id;
        emit ArmedOnEvent(id, emitter, topic0);
    }

    /// @notice Cancel the persistent event subscription.
    function disarmEvent() external onlyOwner {
        if (eventSubscriptionId != 0) {
            _unsubscribe(eventSubscriptionId);
            eventSubscriptionId = 0;
        }
    }

    function setInterval(uint64 newIntervalSeconds) external onlyOwner {
        intervalSeconds = newIntervalSeconds;
    }

    function setFees(uint64 priority, uint64 maxFee, uint64 gasLimit) external onlyOwner {
        priorityFeePerGas = priority;
        maxFeePerGas = maxFee;
        wakeGasLimit = gasLimit;
    }

    /// @dev The chain calls this. Record the wake, then put ourselves back on the clock.
    function _onEvent(address emitter, bytes32[] calldata, bytes calldata) internal override {
        unchecked {
            wakeCount++;
        }
        lastWakeBlock = block.number;
        lastWakeTimestamp = block.timestamp;
        emit Woke(wakeCount, emitter, block.number, block.timestamp);

        if (!running) return;

        // Re-arm. Wrapped so a failure here is visible but never reverts the wake itself,
        // which would roll back the counter and hide that the chain did call us.
        try this.externalArm(intervalSeconds) {}
        catch (bytes memory reason) {
            emit ReArmFailed(reason);
        }
    }

    /// @dev Only exists so `_onEvent` can try/catch the precompile call.
    function externalArm(uint64 delaySeconds) external {
        if (msg.sender != address(this)) revert NotOwner();
        _arm(delaySeconds);
    }

    function _arm(uint64 delaySeconds) private {
        uint256 whenMillis = (block.timestamp + delaySeconds) * 1000;
        uint256 id = _scheduleAtTimestamp(whenMillis, priorityFeePerGas, maxFeePerGas, wakeGasLimit);
        currentSubscriptionId = id;
        nextWakeAtMillis = whenMillis;
        emit Armed(id, whenMillis);
    }

    /// @notice Handler execution is billed to the subscription owner, which is this contract.
    receive() external payable {}

    function withdraw() external onlyOwner {
        (bool ok,) = owner.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }
}
