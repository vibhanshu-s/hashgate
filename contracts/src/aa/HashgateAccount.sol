// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {WOTS} from "../WOTS.sol";
import {IAccount, IEntryPoint, PackedUserOperation} from "./IEntryPoint.sol";

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title HashgateAccount — a post-quantum ERC-4337 smart account for AI payment agents
/// @notice Every UserOperation is authorised by a WOTS one-time signature over the `userOpHash`,
///         checked in `validateUserOp`. There is no ECDSA key anywhere in the account.
///
///  - The owner key (a Merkle tree of WOTS keys) can call anything: open/revoke sessions,
///    execute arbitrary calls (e.g. withdraw), rotate itself.
///  - A session key (a second tree) can only call `agentPay`, and validation enforces its policy:
///    per-payment cap, total budget, payee allowlist, revocation. Expiry is returned as
///    `validUntil`, so the EntryPoint (not a TIMESTAMP read) rejects expired sessions — this keeps
///    validation inside ERC-7562 rules for QDay's safe-mode bundler.
///  - Validation reads and writes only this account's own storage.
///
/// Deployed as EIP-1167 clones by `HashgateAccountFactory`; `ENTRY_POINT` and `TOKEN` are
/// immutables of the implementation and shared by every clone.
contract HashgateAccount is IAccount {
    struct Key {
        bytes32 pubSeed;
        bytes32 root;
        uint8 height;
    }

    struct OTS {
        uint32 leafIndex;
        bytes sig;
        bytes32[] path;
    }

    struct Session {
        Key key;
        uint128 maxPerPayment;
        uint128 budget;
        uint128 spent;
        uint48 expiresAt;
        uint32 payments;
        bool anyPayee;
        bool revoked;
        bool exists;
    }

    uint8 public constant ROLE_OWNER = 0;
    uint8 public constant ROLE_SESSION = 1;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;
    uint8 public constant MAX_HEIGHT = 12;

    IEntryPoint public immutable ENTRY_POINT;
    address public immutable TOKEN;

    Key public owner;
    bool public initialized;
    uint32 public sessionCount;
    mapping(bytes32 sessionId => Session) internal _sessions;
    mapping(bytes32 sessionId => mapping(address => bool)) public payeeAllowed;
    mapping(bytes32 keyId => mapping(uint256 word => uint256 bits)) internal _usedLeaves;
    mapping(bytes32 keyId => uint32) public leavesUsed;

    event AccountInitialized(bytes32 pubSeed, bytes32 root, uint8 height);
    event SessionOpened(
        bytes32 indexed sessionId, uint128 maxPerPayment, uint128 budget, uint48 expiresAt, address[] payees
    );
    event SessionRevoked(bytes32 indexed sessionId);
    event AgentPaid(bytes32 indexed sessionId, address indexed to, uint256 amount, bytes32 memo);
    event Executed(address indexed to, uint256 value, bytes4 selector);
    event OwnerKeyRotated(bytes32 pubSeed, bytes32 root, uint8 height);

    error NotEntryPoint();
    error AlreadyInitialized();
    error BadKey();
    error BadPolicy();
    error BadRole();
    error UnknownSession();
    error SessionExists();
    error SessionIsRevoked();
    error SessionExpired();
    error SessionMayOnlyPay();
    error SessionMismatch();
    error OverPerPaymentCap(uint256 amount, uint256 cap);
    error OverBudget(uint256 wouldSpend, uint256 budget);
    error PayeeNotAllowed(address payee);
    error LeafAlreadyUsed(uint32 leafIndex);
    error ZeroAmount();
    error TransferFailed();
    error CallFailed(bytes reason);

    modifier onlyEntryPoint() {
        if (msg.sender != address(ENTRY_POINT)) revert NotEntryPoint();
        _;
    }

    constructor(IEntryPoint entryPoint, address token) {
        ENTRY_POINT = entryPoint;
        TOKEN = token;
        initialized = true; // the implementation itself can never be initialised
    }

    function initialize(Key calldata k) external {
        if (initialized) revert AlreadyInitialized();
        _checkKey(k);
        initialized = true;
        owner = k;
        emit AccountInitialized(k.pubSeed, k.root, k.height);
    }

    receive() external payable {}

    // ───────────────────────────── ERC-4337 validation ─────────────────────────────

    /// signature = abi.encode(uint8 role, bytes32 sessionId, OTS ots); the WOTS key signs `userOpHash`.
    function validateUserOp(PackedUserOperation calldata op, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        onlyEntryPoint
        returns (uint256 validationData)
    {
        (uint8 role, bytes32 sessionId, OTS memory ots) = abi.decode(op.signature, (uint8, bytes32, OTS));
        (Key memory key, uint256 validUntil) = _authorisedKey(op, role, sessionId);
        bool ok = _consume(key, ots, userOpHash);
        validationData = (ok ? 0 : SIG_VALIDATION_FAILED) | (validUntil << 160);

        if (missingAccountFunds != 0) {
            (bool paid,) = payable(msg.sender).call{value: missingAccountFunds}("");
            paid; // the EntryPoint checks the deposit itself
        }
    }

    // ───────────────────────────── execution (EntryPoint only) ─────────────────────────────

    /// Session keys can reach only this function; the policy was checked in validation and is
    /// checked again here (expiry included, since execution may read the timestamp).
    function agentPay(bytes32 sessionId, address to, uint256 amount, bytes32 memo) external onlyEntryPoint {
        Session storage s = _sessions[sessionId];
        if (!s.exists) revert UnknownSession();
        if (s.revoked) revert SessionIsRevoked();
        if (block.timestamp >= s.expiresAt) revert SessionExpired();
        _checkPolicy(sessionId, s, to, amount);
        s.spent += uint128(amount);
        s.payments += 1;
        if (!IERC20Min(TOKEN).transfer(to, amount)) revert TransferFailed();
        emit AgentPaid(sessionId, to, amount, memo);
    }

    function openSession(Key calldata sessionKey, uint128 maxPerPayment, uint128 budget, uint48 expiresAt, address[] calldata payees)
        external
        onlyEntryPoint
        returns (bytes32 sessionId)
    {
        _checkKey(sessionKey);
        if (maxPerPayment == 0 || budget == 0 || maxPerPayment > budget || expiresAt <= block.timestamp) revert BadPolicy();
        sessionId = sessionIdOf(sessionKey);
        Session storage s = _sessions[sessionId];
        if (s.exists) revert SessionExists();
        s.key = sessionKey;
        s.maxPerPayment = maxPerPayment;
        s.budget = budget;
        s.expiresAt = expiresAt;
        s.anyPayee = payees.length == 0;
        s.exists = true;
        for (uint256 i = 0; i < payees.length; ++i) {
            payeeAllowed[sessionId][payees[i]] = true;
        }
        sessionCount += 1;
        emit SessionOpened(sessionId, maxPerPayment, budget, expiresAt, payees);
    }

    function revokeSession(bytes32 sessionId) external onlyEntryPoint {
        Session storage s = _sessions[sessionId];
        if (!s.exists) revert UnknownSession();
        s.revoked = true;
        emit SessionRevoked(sessionId);
    }

    function rotateOwnerKey(Key calldata newOwner) external onlyEntryPoint {
        _checkKey(newOwner);
        owner = newOwner;
        emit OwnerKeyRotated(newOwner.pubSeed, newOwner.root, newOwner.height);
    }

    /// Owner-only in practice: session keys are limited to `agentPay` during validation.
    function execute(address to, uint256 value, bytes calldata data) external onlyEntryPoint {
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        emit Executed(to, value, data.length >= 4 ? bytes4(data[:4]) : bytes4(0));
    }

    // ───────────────────────────── views ─────────────────────────────

    function getSession(bytes32 sessionId) external view returns (Session memory s, uint32 used) {
        s = _sessions[sessionId];
        used = leavesUsed[keyIdOf(s.key)];
    }

    function ownerKey() external view returns (Key memory k, uint32 used) {
        k = owner;
        used = leavesUsed[keyIdOf(k)];
    }

    function isLeafUsed(Key calldata k, uint32 leafIndex) external view returns (bool) {
        return _usedLeaves[keyIdOf(k)][leafIndex >> 8] & (1 << (leafIndex & 255)) != 0;
    }

    /// Policy dry-run for UIs (0 = OK; codes match Hashgate.sol). Expiry is checked here too.
    function checkPayment(bytes32 sessionId, address to, uint256 amount) external view returns (uint8) {
        Session storage s = _sessions[sessionId];
        if (!s.exists) return 1;
        if (s.revoked) return 2;
        if (block.timestamp >= s.expiresAt) return 3;
        if (amount == 0) return 8;
        if (amount > s.maxPerPayment) return 4;
        if (uint256(s.spent) + amount > s.budget) return 5;
        if (!s.anyPayee && !payeeAllowed[sessionId][to]) return 6;
        return 0;
    }

    function sessionIdOf(Key calldata k) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), k.pubSeed, k.root, k.height));
    }

    function keyIdOf(Key memory k) public pure returns (bytes32) {
        return keccak256(abi.encode(k.pubSeed, k.root));
    }

    // ───────────────────────────── internals ─────────────────────────────

    /// Which key must have signed this op, and until when it is valid. Reverts on policy violations.
    function _authorisedKey(PackedUserOperation calldata op, uint8 role, bytes32 sessionId)
        internal
        view
        returns (Key memory key, uint256 validUntil)
    {
        if (role == ROLE_OWNER) return (owner, 0);
        if (role != ROLE_SESSION) revert BadRole();
        Session storage s = _sessions[sessionId];
        if (!s.exists) revert UnknownSession();
        if (s.revoked) revert SessionIsRevoked();
        if (op.callData.length < 4 || bytes4(op.callData[:4]) != this.agentPay.selector) revert SessionMayOnlyPay();
        (bytes32 sid, address to, uint256 amount,) = abi.decode(op.callData[4:], (bytes32, address, uint256, bytes32));
        if (sid != sessionId) revert SessionMismatch();
        _checkPolicy(sessionId, s, to, amount);
        return (s.key, s.expiresAt);
    }

    /// Verifies the WOTS signature over `digest` and burns the leaf. Returns false on a bad signature
    /// (ERC-4337 SIG_VALIDATION_FAILED), reverts on a reused leaf.
    function _consume(Key memory key, OTS memory ots, bytes32 digest) internal returns (bool) {
        bytes32 keyId = keyIdOf(key);
        uint256 word = ots.leafIndex >> 8;
        uint256 bit = 1 << (ots.leafIndex & 255);
        uint256 bits = _usedLeaves[keyId][word];
        if (bits & bit != 0) revert LeafAlreadyUsed(ots.leafIndex);
        if (!WOTS.verifyMem(key.pubSeed, key.root, key.height, ots.leafIndex, digest, ots.sig, ots.path)) return false;
        _usedLeaves[keyId][word] = bits | bit;
        leavesUsed[keyId] += 1;
        return true;
    }

    function _checkPolicy(bytes32 sessionId, Session storage s, address to, uint256 amount) internal view {
        if (amount == 0) revert ZeroAmount();
        if (amount > s.maxPerPayment) revert OverPerPaymentCap(amount, s.maxPerPayment);
        if (uint256(s.spent) + amount > s.budget) revert OverBudget(uint256(s.spent) + amount, s.budget);
        if (!s.anyPayee && !payeeAllowed[sessionId][to]) revert PayeeNotAllowed(to);
    }

    function _checkKey(Key calldata k) internal pure {
        if (k.height < 1 || k.height > MAX_HEIGHT || k.root == bytes32(0) || k.pubSeed == bytes32(0)) revert BadKey();
    }
}
