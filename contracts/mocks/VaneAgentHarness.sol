// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {VaneAgent} from "../VaneAgent.sol";

/// @notice Test-only subclass that points the handler at a mock precompile.
/// @dev A local EVM reserves 0x0100 and intercepts calls to it, so the real address
///      cannot be exercised off-chain. Only the address changes; all logic is inherited.
contract VaneAgentHarness is VaneAgent {
    address private immutable _mock;

    constructor(address owner_, address collateral_, address operator_, address mock)
        VaneAgent(owner_, collateral_, operator_)
    {
        _mock = mock;
    }

    function _reactivity() internal view override returns (address) {
        return _mock;
    }
}
