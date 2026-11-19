// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Minimal ERC-4337 v0.7 types (EntryPoint 0x0000000071727De22E5E9d8BAf0edAc6f37da032).
struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits; // verificationGasLimit (16 bytes) ‖ callGasLimit (16 bytes)
    uint256 preVerificationGas;
    bytes32 gasFees; // maxPriorityFeePerGas (16 bytes) ‖ maxFeePerGas (16 bytes)
    bytes paymasterAndData; // paymaster (20) ‖ verificationGasLimit (16) ‖ postOpGasLimit (16) ‖ data
    bytes signature;
}

interface IEntryPoint {
    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external;
    function getUserOpHash(PackedUserOperation calldata op) external view returns (bytes32);
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function depositTo(address account) external payable;
    function balanceOf(address account) external view returns (uint256);
    function withdrawTo(address payable to, uint256 amount) external;
    function addStake(uint32 unstakeDelaySec) external payable;
}

interface IAccount {
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256 validationData);
}

enum PostOpMode {
    opSucceeded,
    opReverted,
    postOpReverted
}

interface IPaymaster {
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 maxCost)
        external
        returns (bytes memory context, uint256 validationData);

    function postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas)
        external;
}
