// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {HashgateAccount} from "./HashgateAccount.sol";

/// @title HashgateAccountFactory — deterministic EIP-1167 clones of HashgateAccount
/// @notice No storage, so it can be used from a UserOperation's initCode without staking.
///         The account address depends only on the owner key commitment and a salt.
contract HashgateAccountFactory {
    HashgateAccount public immutable IMPLEMENTATION;

    event AccountCreated(address indexed account, bytes32 pubSeed, bytes32 root, uint8 height, bytes32 salt);

    constructor(HashgateAccount implementation) {
        IMPLEMENTATION = implementation;
    }

    function createAccount(HashgateAccount.Key calldata ownerKey, bytes32 salt) external returns (HashgateAccount account) {
        address predicted = getAddress(ownerKey, salt);
        if (predicted.code.length > 0) return HashgateAccount(payable(predicted));
        bytes memory code = _cloneCode();
        bytes32 s = _salt(ownerKey, salt);
        address deployed;
        assembly {
            deployed := create2(0, add(code, 32), mload(code), s)
        }
        require(deployed != address(0), "create2 failed");
        account = HashgateAccount(payable(deployed));
        account.initialize(ownerKey);
        emit AccountCreated(deployed, ownerKey.pubSeed, ownerKey.root, ownerKey.height, salt);
    }

    function getAddress(HashgateAccount.Key calldata ownerKey, bytes32 salt) public view returns (address) {
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(ownerKey, salt), keccak256(_cloneCode())));
        return address(uint160(uint256(h)));
    }

    /// keccak256 of every clone's runtime code; the paymaster uses it to recognise Hashgate accounts.
    function cloneRuntimeCodeHash() external view returns (bytes32) {
        return keccak256(
            abi.encodePacked(hex"363d3d373d3d3d363d73", address(IMPLEMENTATION), hex"5af43d82803e903d91602b57fd5bf3")
        );
    }

    function _salt(HashgateAccount.Key calldata k, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(k.pubSeed, k.root, k.height, salt));
    }

    function _cloneCode() internal view returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", address(IMPLEMENTATION), hex"5af43d82803e903d91602b57fd5bf3"
        );
    }
}
