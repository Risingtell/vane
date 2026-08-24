// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice The Somnia on-chain reactivity precompile at 0x0100.
/// @dev Struct field order and the `subscribe` signature were confirmed against the
///      live precompile ABI shipped in the somnia-chain reactivity package 0.2.1, and cross-checked
///      against subscription 0x1 read from Shannon via somnia_reactivityGetSubscriptionInfo.
interface ISomniaReactivity {
    struct SubscriptionData {
        /// @dev Topic filters, in order. A zero entry means "match any".
        bytes32[4] eventTopics;
        /// @dev Match logs from this tx sender. Zero matches any.
        address origin;
        /// @dev Reserved by the protocol. Always pass the zero address.
        address caller;
        /// @dev Match logs from this contract. Use the precompile itself for system events.
        address emitter;
        /// @dev Contract invoked on a match. Must be non-zero.
        address handlerContractAddress;
        /// @dev Selector invoked on the handler. onEvent(address,bytes32[],bytes) = 0x53edf33d.
        bytes4 handlerFunctionSelector;
        /// @dev Tip to validators, in wei. Decides queue order when a block is congested.
        uint64 priorityFeePerGas;
        /// @dev Max total fee per gas. Zero uses the protocol default.
        uint64 maxFeePerGas;
        /// @dev Max gas per invocation. Non-zero, and at most 200,000,000.
        uint64 gasLimit;
        /// @dev Reserved by the protocol. Always pass false.
        bool isGuaranteed;
        /// @dev Reserved by the protocol. Always pass false.
        bool isCoalesced;
    }

    event BlockTick(uint64 indexed blockNumber);
    event Schedule(uint256 indexed timestampMillis);
    event SubscriptionCreated(uint256 indexed subscriptionId, address indexed owner, SubscriptionData subscriptionData);
    event SubscriptionRemoved(uint256 indexed subscriptionId, address indexed owner);

    function subscribe(SubscriptionData calldata subscriptionData) external returns (uint256 subscriptionId);

    function unsubscribe(uint256 subscriptionId) external;

    function getSubscriptionInfo(uint256 subscriptionId)
        external
        view
        returns (SubscriptionData memory subscriptionData, address owner);
}
