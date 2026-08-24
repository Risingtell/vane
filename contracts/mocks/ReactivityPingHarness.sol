// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ReactivityPing} from "../spike/ReactivityPing.sol";

/// @notice Test-only subclass that points the handler at a mock precompile.
/// @dev A local EVM reserves 0x0100 and intercepts calls to it, so the real address
///      cannot be exercised off-chain. Only the address changes; all logic is inherited.
contract ReactivityPingHarness is ReactivityPing {
    address private immutable _mock;

    constructor(address mock) {
        _mock = mock;
    }

    function _reactivity() internal view override returns (address) {
        return _mock;
    }

    /// @notice Exposed so tests can assert which address this instance trusts.
    function reactivityAddress() external view returns (address) {
        return _reactivity();
    }
}
