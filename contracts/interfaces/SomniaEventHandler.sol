// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ISomniaReactivity} from "./ISomniaReactivity.sol";

/// @notice Base contract for anything the Somnia chain is allowed to wake.
/// @dev The precompile calls `onEvent(address,bytes32[],bytes)` (selector 0x53edf33d) with
///      msg.sender set to the precompile and tx.origin set to the subscription owner.
abstract contract SomniaEventHandler {
    /// @dev Verified live on Shannon: subscription 0x1 carries handler selector 0x53edf33d.
    address internal constant SOMNIA_REACTIVITY = 0x0000000000000000000000000000000000000100;

    /// @dev topic0 of Schedule(uint256 indexed timestampMillis).
    bytes32 internal constant TOPIC_SCHEDULE = 0x67aa3d752967d87d8944b9c7adf73172518777fa4703f336edee81f0736d8987;
    /// @dev topic0 of BlockTick(uint64 indexed blockNumber).
    bytes32 internal constant TOPIC_BLOCK_TICK = 0x758ef516c6953f00626f7bc382a398f5ddc4e9b44c86035e7c0c0a7b8a9b46ae;
    /// @dev topic0 of EpochTick(uint64 indexed epochNumber, uint64 indexed blockNumber).
    bytes32 internal constant TOPIC_EPOCH_TICK = 0x2e0c8e351f738401ab3e8e932f7251c170afb7b5539cbab5d24743f09b52aec8;

    error OnlyReactivityPrecompile(address caller);

    /// @notice Address the chain calls us from, and that we call to subscribe.
    /// @dev Fixed by the protocol in production. Overridable only so tests can point at a
    ///      mock, because a local EVM reserves 0x0100 and intercepts calls to it.
    function _reactivity() internal view virtual returns (address) {
        return SOMNIA_REACTIVITY;
    }

    /// @notice Entry point the chain itself calls. Nothing else may call it.
    function onEvent(address emitter, bytes32[] calldata eventTopics, bytes calldata data) external {
        if (msg.sender != _reactivity()) revert OnlyReactivityPrecompile(msg.sender);
        _onEvent(emitter, eventTopics, data);
    }

    function _onEvent(address emitter, bytes32[] calldata eventTopics, bytes calldata data) internal virtual;

    /// @notice Arm a one-shot wake-up at an absolute timestamp, in milliseconds.
    /// @dev Mirrors scheduleSubscriptionAtTimestamp: filter on the precompile's own
    ///      Schedule event, with the millisecond timestamp as the indexed topic1.
    function _scheduleAtTimestamp(uint256 timestampMillis, uint64 priorityFeePerGas, uint64 maxFeePerGas, uint64 gasLimit)
        internal
        returns (uint256 subscriptionId)
    {
        bytes32[4] memory topics;
        topics[0] = TOPIC_SCHEDULE;
        topics[1] = bytes32(timestampMillis);

        return ISomniaReactivity(_reactivity()).subscribe(
            ISomniaReactivity.SubscriptionData({
                eventTopics: topics,
                origin: address(0),
                caller: address(0),
                emitter: _reactivity(),
                handlerContractAddress: address(this),
                handlerFunctionSelector: this.onEvent.selector,
                priorityFeePerGas: priorityFeePerGas,
                maxFeePerGas: maxFeePerGas,
                gasLimit: gasLimit,
                isGuaranteed: false,
                isCoalesced: false
            })
        );
    }

    /// @notice Arm a wake-up on every new block, or on one specific block number.
    /// @dev Pass blockNumber 0 to match any block.
    function _scheduleAtBlock(uint256 blockNumber, uint64 priorityFeePerGas, uint64 maxFeePerGas, uint64 gasLimit)
        internal
        returns (uint256 subscriptionId)
    {
        bytes32[4] memory topics;
        topics[0] = TOPIC_BLOCK_TICK;
        topics[1] = bytes32(blockNumber);

        return ISomniaReactivity(_reactivity()).subscribe(
            ISomniaReactivity.SubscriptionData({
                eventTopics: topics,
                origin: address(0),
                caller: address(0),
                emitter: _reactivity(),
                handlerContractAddress: address(this),
                handlerFunctionSelector: this.onEvent.selector,
                priorityFeePerGas: priorityFeePerGas,
                maxFeePerGas: maxFeePerGas,
                gasLimit: gasLimit,
                isGuaranteed: false,
                isCoalesced: false
            })
        );
    }

    /// @notice Arm a PERSISTENT wake-up on a real contract's event.
    /// @dev Unlike the scheduleAt* helpers, which are one-shot and removed after firing,
    ///      an event subscription stays armed and re-fires on every matching log. This is
    ///      what lets an agent run forever without a timer, a keeper or a re-arm step.
    /// @param emitter Contract whose logs we want. Zero matches any contract.
    /// @param topic0 Event signature to match. Zero matches any event.
    function _subscribeToEvent(
        address emitter,
        bytes32 topic0,
        uint64 priorityFeePerGas,
        uint64 maxFeePerGas,
        uint64 gasLimit
    ) internal returns (uint256 subscriptionId) {
        bytes32[4] memory topics;
        topics[0] = topic0;

        return ISomniaReactivity(_reactivity()).subscribe(
            ISomniaReactivity.SubscriptionData({
                eventTopics: topics,
                origin: address(0),
                caller: address(0),
                emitter: emitter,
                handlerContractAddress: address(this),
                handlerFunctionSelector: this.onEvent.selector,
                priorityFeePerGas: priorityFeePerGas,
                maxFeePerGas: maxFeePerGas,
                gasLimit: gasLimit,
                isGuaranteed: false,
                isCoalesced: false
            })
        );
    }

    function _unsubscribe(uint256 subscriptionId) internal {
        ISomniaReactivity(_reactivity()).unsubscribe(subscriptionId);
    }
}
