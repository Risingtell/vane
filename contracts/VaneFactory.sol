// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {VaneAgent} from "./VaneAgent.sol";

/// @title VaneFactory
/// @notice Deploys one VaneAgent per user, so nobody's collateral is ever pooled with
///         anybody else's.
/// @dev The factory never takes custody and never holds a privileged role on an agent.
///      It only records which agent belongs to whom, so a console can find a user's agent
///      from their address alone.
contract VaneFactory {
    /// @notice Collateral every agent from this factory trades (tUSDC on Shannon).
    address public immutable collateral;

    /// @notice Default operator handed to new agents. Each owner can change or clear it.
    address public immutable defaultOperator;

    /// @notice One agent per address. Zero means the user has none yet.
    mapping(address => address) public agentOf;

    address[] public allAgents;

    event AgentCreated(address indexed owner, address indexed agent, uint256 index);

    error AgentAlreadyExists(address agent);

    constructor(address collateral_, address defaultOperator_) {
        collateral = collateral_;
        defaultOperator = defaultOperator_;
    }

    /// @notice Create the caller's agent. One per address, so a second call reverts rather
    ///         than silently orphaning the first one and the funds inside it.
    function createAgent() external returns (address agent) {
        address existing = agentOf[msg.sender];
        if (existing != address(0)) revert AgentAlreadyExists(existing);

        agent = address(new VaneAgent(msg.sender, collateral, defaultOperator));
        agentOf[msg.sender] = agent;
        allAgents.push(agent);
        emit AgentCreated(msg.sender, agent, allAgents.length - 1);
    }

    function agentCount() external view returns (uint256) {
        return allAgents.length;
    }
}
