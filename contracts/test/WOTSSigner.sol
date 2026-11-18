// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Hashgate} from "../src/Hashgate.sol";

/// Test-only WOTS key tree in Solidity, mirroring packages/sdk (seed derivation, chains, tree).
/// Expensive (2**height * 67 * 15 keccaks), so tests use small heights.
contract WOTSSigner {
    bytes32 public pubSeed;
    bytes32 internal skSeed;
    uint8 public height;
    bytes32[][] internal levels;

    constructor(bytes32 seed, uint8 height_) {
        pubSeed = keccak256(abi.encodePacked("hashgate.pubSeed", seed));
        skSeed = keccak256(abi.encodePacked("hashgate.skSeed", seed));
        height = height_;
        uint256 n = 1 << height_;
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) leaves[i] = _leaf(i);
        levels.push(leaves);
        for (uint256 h = 0; h < height_; ++h) {
            bytes32[] memory prev = levels[h];
            bytes32[] memory next = new bytes32[](prev.length / 2);
            for (uint256 i = 0; i < next.length; ++i) next[i] = keccak256(abi.encodePacked(prev[2 * i], prev[2 * i + 1]));
            levels.push(next);
        }
    }

    function key() external view returns (Hashgate.Key memory) {
        return Hashgate.Key(pubSeed, levels[height][0], height);
    }

    function sign(uint32 leaf, bytes32 digest) external view returns (Hashgate.OTS memory o) {
        uint8[67] memory d = _digits(digest);
        bytes memory sig = new bytes(67 * 32);
        for (uint256 i = 0; i < 67; ++i) {
            bytes32 x = _chain(_start(leaf, i), leaf, i, 0, d[i]);
            assembly {
                mstore(add(add(sig, 32), mul(i, 32)), x)
            }
        }
        bytes32[] memory path = new bytes32[](height);
        uint256 idx = leaf;
        for (uint256 h = 0; h < height; ++h) {
            path[h] = levels[h][idx ^ 1];
            idx >>= 1;
        }
        o = Hashgate.OTS(leaf, sig, path);
    }

    function _digits(bytes32 digest) internal pure returns (uint8[67] memory d) {
        uint256 csum;
        for (uint256 i = 0; i < 64; ++i) {
            d[i] = uint8((uint256(digest) >> (252 - 4 * i)) & 15);
            csum += 15 - d[i];
        }
        d[64] = uint8((csum >> 8) & 15);
        d[65] = uint8((csum >> 4) & 15);
        d[66] = uint8(csum & 15);
    }

    function _start(uint256 leaf, uint256 chain) internal view returns (bytes32) {
        return keccak256(abi.encode(skSeed, (leaf << 16) | (chain << 8)));
    }

    function _chain(bytes32 x, uint256 leaf, uint256 chain, uint256 from, uint256 to) internal view returns (bytes32) {
        for (uint256 j = from; j < to; ++j) x = keccak256(abi.encode(pubSeed, (leaf << 16) | (chain << 8) | j, x));
        return x;
    }

    function _leaf(uint256 leaf) internal view returns (bytes32) {
        bytes memory buf = abi.encode(pubSeed, (uint256(1) << 255) | leaf);
        for (uint256 i = 0; i < 67; ++i) buf = abi.encodePacked(buf, _chain(_start(leaf, i), leaf, i, 0, 15));
        return keccak256(buf);
    }
}
