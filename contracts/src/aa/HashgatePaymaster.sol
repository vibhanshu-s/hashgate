// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IEntryPoint, IPaymaster, PackedUserOperation, PostOpMode} from "./IEntryPoint.sol";

/// @title HashgatePaymaster — sponsors gas for Hashgate accounts, and only for them
/// @notice Recognises a Hashgate account by the keccak256 of its runtime code (every EIP-1167 clone of the
///         implementation has the same one), so validation touches no storage and the paymaster
///         needs no stake under ERC-7562. It caps the cost of a single operation.
///         The admin key here only manages the gas deposit; it has no power over any account.
contract HashgatePaymaster is IPaymaster {
    IEntryPoint public immutable ENTRY_POINT;
    bytes32 public immutable ACCOUNT_CODEHASH;
    uint256 public immutable MAX_COST;
    address public immutable admin;

    error NotEntryPoint();
    error NotAdmin();
    error NotHashgateAccount(address sender);
    error TooExpensive(uint256 maxCost, uint256 limit);

    constructor(IEntryPoint entryPoint, bytes32 accountCodehash, uint256 maxCost) {
        ENTRY_POINT = entryPoint;
        ACCOUNT_CODEHASH = accountCodehash;
        MAX_COST = maxCost;
        admin = msg.sender;
    }

    function validatePaymasterUserOp(PackedUserOperation calldata op, bytes32, uint256 maxCost)
        external
        view
        returns (bytes memory context, uint256 validationData)
    {
        if (msg.sender != address(ENTRY_POINT)) revert NotEntryPoint();
        // keccak256 of the code itself, not EXTCODEHASH: on Aevum (cdk-erigon zkEVM) EXTCODEHASH
        // returns the node's own code hash, not keccak256(code).
        if (keccak256(op.sender.code) != ACCOUNT_CODEHASH) revert NotHashgateAccount(op.sender);
        if (maxCost > MAX_COST) revert TooExpensive(maxCost, MAX_COST);
        return ("", 0);
    }

    function postOp(PostOpMode, bytes calldata, uint256, uint256) external pure {}

    function deposit() external payable {
        ENTRY_POINT.depositTo{value: msg.value}(address(this));
    }

    function withdrawTo(address payable to, uint256 amount) external {
        if (msg.sender != admin) revert NotAdmin();
        ENTRY_POINT.withdrawTo(to, amount);
    }

    function addStake(uint32 unstakeDelaySec) external payable {
        if (msg.sender != admin) revert NotAdmin();
        ENTRY_POINT.addStake{value: msg.value}(unstakeDelaySec);
    }
}
