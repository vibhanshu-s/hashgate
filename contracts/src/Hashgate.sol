// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {WOTS} from "./WOTS.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// EIP-3009, as implemented by tUSD8 (USDC-style).
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title Hashgate — post-quantum session keys for AI payment agents
/// @notice Stablecoin vaults whose every spending decision is authorised by a hash-based
///         (WOTS, Winternitz) one-time signature instead of ECDSA.
///
///  - A vault is owned by a Merkle tree of one-time WOTS keys ("owner key"). Opening or revoking an
///    agent session, withdrawing and rotating the owner key each consume one owner leaf.
///  - An agent session is a second key tree plus a policy: per-payment cap, total budget, expiry
///    and an optional payee allowlist. Each agent payment consumes one session leaf.
///  - There is no admin, no ECDSA owner and no upgrade path. `msg.sender` is never trusted for
///    authorisation, so any relayer can submit transactions and a stolen ECDSA key moves nothing.
contract Hashgate {
    // ───────────────────────────── types ─────────────────────────────

    /// A committed tree of one-time WOTS keys.
    struct Key {
        bytes32 pubSeed; // public randomness, mixed into every hash (domain separation)
        bytes32 root; // Merkle root of the one-time public keys
        uint8 height; // tree height: 2**height one-time keys
    }

    /// One one-time signature with its Merkle authentication path.
    struct OTS {
        uint32 leafIndex;
        bytes sig; // 67 * 32 bytes
        bytes32[] path; // `height` siblings, leaf level first
    }

    struct Vault {
        Key owner;
        uint256 balance; // tUSD8 held for this vault (6 decimals)
        uint32 sessions; // number of sessions ever opened
        bool exists;
    }

    struct Policy {
        uint128 maxPerPayment;
        uint128 budget; // lifetime total the session may spend
        uint64 expiresAt; // unix seconds
        address[] payees; // empty = any payee
    }

    struct Session {
        bytes32 vaultId;
        Key key;
        uint128 maxPerPayment;
        uint128 budget;
        uint128 spent;
        uint64 expiresAt;
        uint32 payments;
        bool anyPayee;
        bool revoked;
        bool exists;
    }

    // Operation tags, part of every signed digest.
    bytes32 public constant OP_OPEN_SESSION = keccak256("hashgate.openSession");
    bytes32 public constant OP_REVOKE_SESSION = keccak256("hashgate.revokeSession");
    bytes32 public constant OP_WITHDRAW = keccak256("hashgate.withdraw");
    bytes32 public constant OP_ROTATE_OWNER = keccak256("hashgate.rotateOwner");
    bytes32 public constant OP_PAY = keccak256("hashgate.pay");

    uint8 public constant MAX_HEIGHT = 12; // 4096 one-time keys per tree
    uint8 public constant MIN_HEIGHT = 1;

    // Reason codes returned by `checkPayment`, mirroring the custom errors below.
    uint8 public constant OK = 0;
    uint8 public constant R_UNKNOWN_SESSION = 1;
    uint8 public constant R_REVOKED = 2;
    uint8 public constant R_EXPIRED = 3;
    uint8 public constant R_OVER_PER_PAYMENT = 4;
    uint8 public constant R_OVER_BUDGET = 5;
    uint8 public constant R_PAYEE_NOT_ALLOWED = 6;
    uint8 public constant R_VAULT_BALANCE = 7;
    uint8 public constant R_ZERO_AMOUNT = 8;

    // ───────────────────────────── state ─────────────────────────────

    IERC20 public immutable token;
    bytes32 public immutable domain;

    mapping(bytes32 vaultId => Vault) internal _vaults;
    mapping(bytes32 sessionId => Session) internal _sessions;
    mapping(bytes32 sessionId => mapping(address payee => bool)) public payeeAllowed;
    /// Used-leaf bitmaps, keyed by keyId = keccak256(pubSeed, root).
    mapping(bytes32 keyId => mapping(uint256 word => uint256 bits)) internal _usedLeaves;
    mapping(bytes32 keyId => uint32) public leavesUsed;

    // ───────────────────────────── events ─────────────────────────────

    event VaultCreated(bytes32 indexed vaultId, bytes32 pubSeed, bytes32 root, uint8 height);
    event Deposited(bytes32 indexed vaultId, address indexed from, uint256 amount);
    event SessionOpened(
        bytes32 indexed vaultId,
        bytes32 indexed sessionId,
        uint128 maxPerPayment,
        uint128 budget,
        uint64 expiresAt,
        address[] payees,
        uint32 ownerLeaf
    );
    event SessionRevoked(bytes32 indexed vaultId, bytes32 indexed sessionId, uint32 ownerLeaf);
    event AgentPaid(
        bytes32 indexed vaultId,
        bytes32 indexed sessionId,
        address indexed to,
        uint256 amount,
        bytes32 memo,
        uint32 sessionLeaf
    );
    event Withdrawn(bytes32 indexed vaultId, address indexed to, uint256 amount, uint32 ownerLeaf);
    event OwnerKeyRotated(bytes32 indexed vaultId, bytes32 pubSeed, bytes32 root, uint8 height, uint32 ownerLeaf);

    // ───────────────────────────── errors ─────────────────────────────

    error UnknownVault();
    error VaultExists();
    error BadKey();
    error BadSignature();
    error LeafAlreadyUsed(uint32 leafIndex);
    error UnknownSession();
    error SessionExists();
    error SessionIsRevoked();
    error SessionExpired();
    error OverPerPaymentCap(uint256 amount, uint256 cap);
    error OverBudget(uint256 wouldSpend, uint256 budget);
    error PayeeNotAllowed(address payee);
    error InsufficientVaultBalance(uint256 balance, uint256 amount);
    error ZeroAmount();
    error BadPolicy();
    error TransferFailed();

    constructor(IERC20 token_) {
        token = token_;
        domain = keccak256(abi.encode("Hashgate v1", block.chainid, address(this)));
    }

    // ───────────────────────────── vaults ─────────────────────────────

    /// @notice Registers a vault for an owner key. Needs no signature: committing to your own
    ///         public key grants nothing until you sign with it. `salt` lets one key own many vaults.
    function createVault(Key calldata owner, bytes32 salt) external returns (bytes32 vaultId) {
        _checkKey(owner);
        vaultId = vaultIdOf(owner, salt);
        Vault storage v = _vaults[vaultId];
        if (v.exists) revert VaultExists();
        v.owner = owner;
        v.exists = true;
        emit VaultCreated(vaultId, owner.pubSeed, owner.root, owner.height);
    }

    /// @notice Deposit with a prior ERC-20 approval. Anyone may fund any vault.
    function deposit(bytes32 vaultId, uint256 amount) external {
        Vault storage v = _vault(vaultId);
        if (amount == 0) revert ZeroAmount();
        v.balance += amount;
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Deposited(vaultId, msg.sender, amount);
    }

    /// @notice Gasless deposit with an EIP-3009 `ReceiveWithAuthorization` signed by `from`.
    ///         The signed nonce must equal `depositNonce(vaultId, salt)`, so a relayer cannot take
    ///         the signature and credit a different vault.
    function depositWithAuthorization(
        bytes32 vaultId,
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 salt,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        Vault storage vault = _vault(vaultId);
        if (amount == 0) revert ZeroAmount();
        bytes32 nonce = depositNonce(vaultId, salt);
        vault.balance += amount;
        IERC3009(address(token)).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, nonce, v, r, s
        );
        emit Deposited(vaultId, from, amount);
    }

    // ───────────────────────────── owner operations (PQ-signed) ─────────────────────────────

    function openSession(bytes32 vaultId, Key calldata sessionKey, Policy calldata policy, OTS calldata ownerSig)
        external
        returns (bytes32 sessionId)
    {
        Vault storage v = _vault(vaultId);
        _checkKey(sessionKey);
        if (policy.maxPerPayment == 0 || policy.budget == 0 || policy.maxPerPayment > policy.budget) {
            revert BadPolicy();
        }
        if (policy.expiresAt <= block.timestamp) revert BadPolicy();

        bytes32 digest = openSessionDigest(vaultId, sessionKey, policy);
        _consume(v.owner, ownerSig, digest);

        sessionId = sessionIdOf(vaultId, sessionKey);
        Session storage s = _sessions[sessionId];
        if (s.exists) revert SessionExists();
        s.vaultId = vaultId;
        s.key = sessionKey;
        s.maxPerPayment = policy.maxPerPayment;
        s.budget = policy.budget;
        s.expiresAt = policy.expiresAt;
        s.anyPayee = policy.payees.length == 0;
        s.exists = true;
        for (uint256 i = 0; i < policy.payees.length; ++i) {
            payeeAllowed[sessionId][policy.payees[i]] = true;
        }
        v.sessions += 1;
        emit SessionOpened(
            vaultId, sessionId, policy.maxPerPayment, policy.budget, policy.expiresAt, policy.payees, ownerSig.leafIndex
        );
    }

    function revokeSession(bytes32 sessionId, OTS calldata ownerSig) external {
        Session storage s = _session(sessionId);
        if (s.revoked) revert SessionIsRevoked();
        Vault storage v = _vaults[s.vaultId];
        _consume(v.owner, ownerSig, revokeDigest(sessionId));
        s.revoked = true;
        emit SessionRevoked(s.vaultId, sessionId, ownerSig.leafIndex);
    }

    function withdraw(bytes32 vaultId, address to, uint256 amount, OTS calldata ownerSig) external {
        Vault storage v = _vault(vaultId);
        if (amount == 0) revert ZeroAmount();
        if (amount > v.balance) revert InsufficientVaultBalance(v.balance, amount);
        _consume(v.owner, ownerSig, withdrawDigest(vaultId, to, amount));
        v.balance -= amount;
        if (!token.transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(vaultId, to, amount, ownerSig.leafIndex);
    }

    /// @notice Moves the vault to a fresh owner key tree (e.g. when the old one runs low on leaves).
    function rotateOwnerKey(bytes32 vaultId, Key calldata newOwner, OTS calldata ownerSig) external {
        Vault storage v = _vault(vaultId);
        _checkKey(newOwner);
        _consume(v.owner, ownerSig, rotateDigest(vaultId, newOwner));
        v.owner = newOwner;
        emit OwnerKeyRotated(vaultId, newOwner.pubSeed, newOwner.root, newOwner.height, ownerSig.leafIndex);
    }

    // ───────────────────────────── agent payments (PQ-signed) ─────────────────────────────

    function pay(bytes32 sessionId, address to, uint256 amount, bytes32 memo, OTS calldata agentSig) external {
        Session storage s = _session(sessionId);
        Vault storage v = _vaults[s.vaultId];
        _enforcePolicy(sessionId, s, v, to, amount);

        _consume(s.key, agentSig, payDigest(sessionId, to, amount, memo));

        s.spent += uint128(amount);
        s.payments += 1;
        v.balance -= amount;
        if (!token.transfer(to, amount)) revert TransferFailed();
        emit AgentPaid(s.vaultId, sessionId, to, amount, memo, agentSig.leafIndex);
    }

    /// @notice Dry-run of the policy (not the signature), so agents and UIs can explain a refusal
    ///         before anything is signed or sent.
    function checkPayment(bytes32 sessionId, address to, uint256 amount) external view returns (uint8) {
        Session storage s = _sessions[sessionId];
        if (!s.exists) return R_UNKNOWN_SESSION;
        if (s.revoked) return R_REVOKED;
        if (block.timestamp >= s.expiresAt) return R_EXPIRED;
        if (amount == 0) return R_ZERO_AMOUNT;
        if (amount > s.maxPerPayment) return R_OVER_PER_PAYMENT;
        if (uint256(s.spent) + amount > s.budget) return R_OVER_BUDGET;
        if (!s.anyPayee && !payeeAllowed[sessionId][to]) return R_PAYEE_NOT_ALLOWED;
        if (amount > _vaults[s.vaultId].balance) return R_VAULT_BALANCE;
        return OK;
    }

    // ───────────────────────────── digests (what the WOTS keys sign) ─────────────────────────────

    function openSessionDigest(bytes32 vaultId, Key calldata k, Policy calldata p) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                domain,
                OP_OPEN_SESSION,
                vaultId,
                k.pubSeed,
                k.root,
                k.height,
                p.maxPerPayment,
                p.budget,
                p.expiresAt,
                keccak256(abi.encodePacked(p.payees))
            )
        );
    }

    function revokeDigest(bytes32 sessionId) public view returns (bytes32) {
        return keccak256(abi.encode(domain, OP_REVOKE_SESSION, sessionId));
    }

    function withdrawDigest(bytes32 vaultId, address to, uint256 amount) public view returns (bytes32) {
        return keccak256(abi.encode(domain, OP_WITHDRAW, vaultId, to, amount, _vaults[vaultId].owner.root));
    }

    function rotateDigest(bytes32 vaultId, Key calldata k) public view returns (bytes32) {
        return keccak256(abi.encode(domain, OP_ROTATE_OWNER, vaultId, k.pubSeed, k.root, k.height));
    }

    function payDigest(bytes32 sessionId, address to, uint256 amount, bytes32 memo) public view returns (bytes32) {
        return keccak256(abi.encode(domain, OP_PAY, sessionId, to, amount, memo));
    }

    // ───────────────────────────── views ─────────────────────────────

    function vaultIdOf(Key calldata owner, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(owner.pubSeed, owner.root, owner.height, salt));
    }

    function sessionIdOf(bytes32 vaultId, Key calldata k) public pure returns (bytes32) {
        return keccak256(abi.encode(vaultId, k.pubSeed, k.root, k.height));
    }

    function keyIdOf(Key memory k) public pure returns (bytes32) {
        return keccak256(abi.encode(k.pubSeed, k.root));
    }

    function depositNonce(bytes32 vaultId, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), vaultId, salt));
    }

    function getVault(bytes32 vaultId)
        external
        view
        returns (Key memory owner, uint256 balance, uint32 sessions, bool exists, uint32 ownerLeavesUsed)
    {
        Vault storage v = _vaults[vaultId];
        return (v.owner, v.balance, v.sessions, v.exists, leavesUsed[keyIdOf(v.owner)]);
    }

    function getSession(bytes32 sessionId) external view returns (Session memory s, uint32 leavesUsed_) {
        s = _sessions[sessionId];
        leavesUsed_ = leavesUsed[keyIdOf(s.key)];
    }

    function isLeafUsed(Key calldata k, uint32 leafIndex) external view returns (bool) {
        return _usedLeaves[keyIdOf(k)][leafIndex >> 8] & (1 << (leafIndex & 255)) != 0;
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _vault(bytes32 vaultId) internal view returns (Vault storage v) {
        v = _vaults[vaultId];
        if (!v.exists) revert UnknownVault();
    }

    function _session(bytes32 sessionId) internal view returns (Session storage s) {
        s = _sessions[sessionId];
        if (!s.exists) revert UnknownSession();
    }

    function _checkKey(Key calldata k) internal pure {
        if (k.height < MIN_HEIGHT || k.height > MAX_HEIGHT || k.root == bytes32(0) || k.pubSeed == bytes32(0)) {
            revert BadKey();
        }
    }

    function _enforcePolicy(bytes32 sessionId, Session storage s, Vault storage v, address to, uint256 amount)
        internal
        view
    {
        if (s.revoked) revert SessionIsRevoked();
        if (block.timestamp >= s.expiresAt) revert SessionExpired();
        if (amount == 0) revert ZeroAmount();
        if (amount > s.maxPerPayment) revert OverPerPaymentCap(amount, s.maxPerPayment);
        if (uint256(s.spent) + amount > s.budget) revert OverBudget(uint256(s.spent) + amount, s.budget);
        if (!s.anyPayee && !payeeAllowed[sessionId][to]) revert PayeeNotAllowed(to);
        if (amount > v.balance) revert InsufficientVaultBalance(v.balance, amount);
    }

    /// Verifies a one-time signature against `k` and burns the leaf. Reverts on reuse or forgery.
    function _consume(Key memory k, OTS calldata ots, bytes32 digest) internal {
        bytes32 keyId = keyIdOf(k);
        uint256 word = ots.leafIndex >> 8;
        uint256 bit = 1 << (ots.leafIndex & 255);
        uint256 bits = _usedLeaves[keyId][word];
        if (bits & bit != 0) revert LeafAlreadyUsed(ots.leafIndex);
        if (!WOTS.verify(k.pubSeed, k.root, k.height, ots.leafIndex, digest, ots.sig, ots.path)) {
            revert BadSignature();
        }
        _usedLeaves[keyId][word] = bits | bit;
        leavesUsed[keyId] += 1;
    }
}
