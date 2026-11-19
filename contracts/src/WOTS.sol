// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title WOTS — Winternitz one-time signature verifier (post-quantum, hash-based)
/// @notice Verifies a WOTS signature (n = 32 bytes, w = 16) built on keccak256, and checks the
///         resulting one-time public key against a Merkle root of many one-time keys.
///
/// Security rests only on keccak256 preimage/second-preimage resistance. Shor's algorithm does
/// not help against it; Grover's algorithm cuts 256-bit preimage security to ~128 bits.
///
/// Parameters (must match the TypeScript SDK in packages/sdk):
///   - message digest: 256 bits, read as 64 base-16 digits, most significant nibble first
///   - checksum: sum(15 - d_i) over those 64 digits (max 960), written as 3 base-16 digits
///   - 67 hash chains of length 15
///   - chain step:  x' = keccak256(pubSeed ‖ tweak ‖ x),  tweak = leaf << 16 | chain << 8 | step
///   - leaf:        keccak256(pubSeed ‖ (1 << 255 | leaf) ‖ pk_0 ‖ … ‖ pk_66)
///   - tree node:   keccak256(left ‖ right), position given by the leaf index bits
/// The tweak makes every hash call in every key unique, which blocks multi-target attacks.
library WOTS {
    uint256 internal constant CHAINS = 67;
    uint256 internal constant SIG_BYTES = 67 * 32;
    uint256 internal constant W_MAX = 15;

    error BadSignatureLength();

    /// @notice Recomputes the one-time key's leaf hash from a signature over `digest`.
    ///         A wrong signature yields a different (random-looking) leaf, so callers must compare
    ///         the result against a committed leaf or Merkle root.
    function leafFromSignature(bytes32 pubSeed, uint256 leafIndex, bytes32 digest, bytes calldata sig)
        internal
        pure
        returns (bytes32 leaf)
    {
        if (sig.length != SIG_BYTES) revert BadSignatureLength();
        /// @solidity memory-safe-assembly
        assembly {
            // Scratch layout from the free memory pointer (never handed out, so no bump needed):
            //   ptr+0    pubSeed      ┐ 96-byte chain-step input
            //   ptr+32   tweak        │
            //   ptr+64   x            ┘
            //   ptr+96   pubSeed      ┐ leaf input: 64 + 67*32 bytes
            //   ptr+128  leaf tag     │
            //   ptr+160  pk_0..pk_66  ┘
            let ptr := mload(0x40)
            mstore(ptr, pubSeed)
            let pkBase := add(ptr, 160)
            let leafTweak := shl(16, leafIndex)
            let csum := 0
            for { let i := 0 } lt(i, 67) { i := add(i, 1) } {
                let d
                switch lt(i, 64)
                case 1 {
                    d := and(shr(sub(252, mul(i, 4)), digest), 15)
                    csum := add(csum, sub(15, d))
                }
                default {
                    // i = 64, 65, 66 -> checksum nibbles, most significant first
                    d := and(shr(mul(sub(66, i), 4), csum), 15)
                }
                let x := calldataload(add(sig.offset, mul(i, 32)))
                let chainTweak := or(leafTweak, shl(8, i))
                for { let j := d } lt(j, 15) { j := add(j, 1) } {
                    mstore(add(ptr, 32), or(chainTweak, j))
                    mstore(add(ptr, 64), x)
                    x := keccak256(ptr, 96)
                }
                mstore(add(pkBase, mul(i, 32)), x)
            }
            mstore(add(ptr, 96), pubSeed)
            mstore(add(ptr, 128), or(shl(255, 1), leafIndex))
            leaf := keccak256(add(ptr, 96), 2208) // 64 + 67*32
        }
    }

    /// @notice Folds a Merkle authentication path from `leaf` at `leafIndex` up to the root.
    function rootFromPath(bytes32 leaf, uint256 leafIndex, bytes32[] calldata path)
        internal
        pure
        returns (bytes32 node)
    {
        node = leaf;
        uint256 idx = leafIndex;
        for (uint256 h = 0; h < path.length; ++h) {
            bytes32 sibling = path[h];
            /// @solidity memory-safe-assembly
            assembly {
                switch and(idx, 1)
                case 0 {
                    mstore(0x00, node)
                    mstore(0x20, sibling)
                }
                default {
                    mstore(0x00, sibling)
                    mstore(0x20, node)
                }
                node := keccak256(0x00, 0x40)
            }
            idx >>= 1;
        }
    }

    /// @notice Full check: signature + Merkle path against a committed root.
    function verify(
        bytes32 pubSeed,
        bytes32 root,
        uint8 height,
        uint256 leafIndex,
        bytes32 digest,
        bytes calldata sig,
        bytes32[] calldata path
    ) internal pure returns (bool) {
        if (path.length != height || leafIndex >> height != 0) return false;
        return rootFromPath(leafFromSignature(pubSeed, leafIndex, digest, sig), leafIndex, path) == root;
    }

    // ── memory variants (for signatures decoded from a UserOperation) ──

    function leafFromSignatureMem(bytes32 pubSeed, uint256 leafIndex, bytes32 digest, bytes memory sig)
        internal
        pure
        returns (bytes32 leaf)
    {
        if (sig.length != SIG_BYTES) revert BadSignatureLength();
        /// @solidity memory-safe-assembly
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, pubSeed)
            let pkBase := add(ptr, 160)
            let leafTweak := shl(16, leafIndex)
            let sigData := add(sig, 32)
            let csum := 0
            for { let i := 0 } lt(i, 67) { i := add(i, 1) } {
                let d
                switch lt(i, 64)
                case 1 {
                    d := and(shr(sub(252, mul(i, 4)), digest), 15)
                    csum := add(csum, sub(15, d))
                }
                default { d := and(shr(mul(sub(66, i), 4), csum), 15) }
                let x := mload(add(sigData, mul(i, 32)))
                let chainTweak := or(leafTweak, shl(8, i))
                for { let j := d } lt(j, 15) { j := add(j, 1) } {
                    mstore(add(ptr, 32), or(chainTweak, j))
                    mstore(add(ptr, 64), x)
                    x := keccak256(ptr, 96)
                }
                mstore(add(pkBase, mul(i, 32)), x)
            }
            mstore(add(ptr, 96), pubSeed)
            mstore(add(ptr, 128), or(shl(255, 1), leafIndex))
            leaf := keccak256(add(ptr, 96), 2208)
        }
    }

    function verifyMem(
        bytes32 pubSeed,
        bytes32 root,
        uint8 height,
        uint256 leafIndex,
        bytes32 digest,
        bytes memory sig,
        bytes32[] memory path
    ) internal pure returns (bool) {
        if (path.length != height || leafIndex >> height != 0 || sig.length != SIG_BYTES) return false;
        bytes32 node = leafFromSignatureMem(pubSeed, leafIndex, digest, sig);
        uint256 idx = leafIndex;
        for (uint256 h = 0; h < path.length; ++h) {
            bytes32 sibling = path[h];
            /// @solidity memory-safe-assembly
            assembly {
                switch and(idx, 1)
                case 0 {
                    mstore(0x00, node)
                    mstore(0x20, sibling)
                }
                default {
                    mstore(0x00, sibling)
                    mstore(0x20, node)
                }
                node := keccak256(0x00, 0x40)
            }
            idx >>= 1;
        }
        return node == root;
    }
}
