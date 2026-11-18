// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, stdJson} from "forge-std/Test.sol";
import {Hashgate, IERC20} from "../src/Hashgate.sol";
import {WOTS} from "../src/WOTS.sol";
import {MockUSD8} from "./mocks/MockUSD8.sol";
import {WOTSSigner} from "./WOTSSigner.sol";

/// Exposes the library to the test (calldata args need an external call).
contract WOTSHarness {
    function verify(bytes32 s, bytes32 r, uint8 h, uint256 i, bytes32 d, bytes calldata sig, bytes32[] calldata p)
        external
        pure
        returns (bool)
    {
        return WOTS.verify(s, r, h, i, d, sig, p);
    }
}

contract HashgateTest is Test {
    using stdJson for string;

    MockUSD8 tok;
    Hashgate hg;
    WOTSHarness harness;
    WOTSSigner owner;
    WOTSSigner agent;
    bytes32 vaultId;
    bytes32 sessionId;
    address payee = address(0xA1);
    address evil = address(0xDEAD);
    bytes32 memo = keccak256("INV-1");
    uint32 ownerLeaf;

    function setUp() public {
        tok = new MockUSD8();
        hg = new Hashgate(IERC20(address(tok)));
        harness = new WOTSHarness();
        owner = new WOTSSigner(keccak256("owner"), 3);
        agent = new WOTSSigner(keccak256("agent"), 2);

        vaultId = hg.createVault(owner.key(), bytes32(0));
        tok.mint(address(this), 100e6);
        tok.approve(address(hg), type(uint256).max);
        hg.deposit(vaultId, 10e6);

        address[] memory payees = new address[](1);
        payees[0] = payee;
        Hashgate.Policy memory p = Hashgate.Policy(1e6, 2e6, uint64(block.timestamp + 1 hours), payees);
        Hashgate.OTS memory sig = owner.sign(ownerLeaf++, _openDigest(agent.key(), p));
        sessionId = hg.openSession(vaultId, agent.key(), p, sig);
    }

    function _openDigest(Hashgate.Key memory k, Hashgate.Policy memory p) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                hg.domain(), hg.OP_OPEN_SESSION(), vaultId, k.pubSeed, k.root, k.height,
                p.maxPerPayment, p.budget, p.expiresAt, keccak256(abi.encodePacked(p.payees))
            )
        );
    }

    function _pay(uint32 leaf, address to, uint256 amount) internal {
        hg.pay(sessionId, to, amount, memo, agent.sign(leaf, hg.payDigest(sessionId, to, amount, memo)));
    }

    // ── cross-language: a signature made by the TypeScript SDK verifies in Solidity ──
    function test_typescriptVectorVerifies() public view {
        string memory j = vm.readFile("test/fixtures/vector.json");
        bytes32 s = j.readBytes32(".pubSeed");
        bytes32 r = j.readBytes32(".root");
        uint8 h = uint8(j.readUint(".height"));
        uint256 i = j.readUint(".leafIndex");
        bytes32 d = j.readBytes32(".digest");
        bytes memory sig = j.readBytes(".sig");
        bytes32[] memory path = j.readBytes32Array(".path");
        assertTrue(harness.verify(s, r, h, i, d, sig, path));
        assertFalse(harness.verify(s, r, h, i, keccak256(abi.encode(d)), sig, path));
        assertFalse(harness.verify(s, r, h, i ^ 1, d, sig, path));
    }

    function testFuzz_signVerify(bytes32 digest, uint8 leafSeed) public view {
        uint32 leaf = uint32(leafSeed % 4);
        Hashgate.OTS memory o = agent.sign(leaf, digest);
        Hashgate.Key memory k = agent.key();
        assertTrue(harness.verify(k.pubSeed, k.root, k.height, leaf, digest, o.sig, o.path));
        assertFalse(harness.verify(k.pubSeed, k.root, k.height, leaf, ~digest, o.sig, o.path));
    }

    function test_payWithinPolicy() public {
        _pay(0, payee, 0.5e6);
        assertEq(tok.balanceOf(payee), 0.5e6);
        (Hashgate.Session memory s, uint32 used) = hg.getSession(sessionId);
        assertEq(s.spent, 0.5e6);
        assertEq(used, 1);
    }

    function test_rejectsPayeeNotAllowed() public {
        Hashgate.OTS memory o = agent.sign(0, hg.payDigest(sessionId, evil, 0.5e6, memo));
        vm.expectRevert(abi.encodeWithSelector(Hashgate.PayeeNotAllowed.selector, evil));
        hg.pay(sessionId, evil, 0.5e6, memo, o);
    }

    function test_rejectsOverCapAndBudget() public {
        Hashgate.OTS memory o = agent.sign(0, hg.payDigest(sessionId, payee, 1.5e6, memo));
        vm.expectRevert(abi.encodeWithSelector(Hashgate.OverPerPaymentCap.selector, 1.5e6, 1e6));
        hg.pay(sessionId, payee, 1.5e6, memo, o);
        _pay(0, payee, 1e6);
        _pay(1, payee, 1e6);
        o = agent.sign(2, hg.payDigest(sessionId, payee, 0.1e6, memo));
        vm.expectRevert(abi.encodeWithSelector(Hashgate.OverBudget.selector, 2.1e6, 2e6));
        hg.pay(sessionId, payee, 0.1e6, memo, o);
    }

    function test_rejectsLeafReuseAndForgery() public {
        _pay(0, payee, 0.1e6);
        Hashgate.OTS memory o = agent.sign(0, hg.payDigest(sessionId, payee, 0.2e6, memo));
        vm.expectRevert(abi.encodeWithSelector(Hashgate.LeafAlreadyUsed.selector, uint32(0)));
        hg.pay(sessionId, payee, 0.2e6, memo, o);
        o = agent.sign(1, hg.payDigest(sessionId, payee, 0.1e6, memo));
        vm.expectRevert(Hashgate.BadSignature.selector);
        hg.pay(sessionId, payee, 0.9e6, memo, o); // amount changed after signing
    }

    function test_relayerHasNoAuthority() public {
        // A stolen ECDSA key (msg.sender) can submit, but cannot authorise anything.
        WOTSSigner attacker = new WOTSSigner(keccak256("attacker"), 3);
        Hashgate.OTS memory o = attacker.sign(5, hg.withdrawDigest(vaultId, evil, 1e6));
        vm.prank(evil);
        vm.expectRevert(Hashgate.BadSignature.selector);
        hg.withdraw(vaultId, evil, 1e6, o);
    }

    function test_revokeStopsAgent() public {
        hg.revokeSession(sessionId, owner.sign(ownerLeaf++, hg.revokeDigest(sessionId)));
        Hashgate.OTS memory o = agent.sign(0, hg.payDigest(sessionId, payee, 0.1e6, memo));
        vm.expectRevert(Hashgate.SessionIsRevoked.selector);
        hg.pay(sessionId, payee, 0.1e6, memo, o);
        assertEq(hg.checkPayment(sessionId, payee, 0.1e6), hg.R_REVOKED());
    }

    function test_expiry() public {
        vm.warp(block.timestamp + 2 hours);
        Hashgate.OTS memory o = agent.sign(0, hg.payDigest(sessionId, payee, 0.1e6, memo));
        vm.expectRevert(Hashgate.SessionExpired.selector);
        hg.pay(sessionId, payee, 0.1e6, memo, o);
    }

    function test_withdraw() public {
        hg.withdraw(vaultId, address(0xBEEF), 3e6, owner.sign(ownerLeaf++, hg.withdrawDigest(vaultId, address(0xBEEF), 3e6)));
        assertEq(tok.balanceOf(address(0xBEEF)), 3e6);
        (, uint256 bal,,,) = hg.getVault(vaultId);
        assertEq(bal, 7e6);
    }

    function test_badPolicy() public {
        WOTSSigner a2 = new WOTSSigner(keccak256("a2"), 1);
        Hashgate.Policy memory p = Hashgate.Policy(3e6, 2e6, uint64(block.timestamp + 1), new address[](0));
        Hashgate.OTS memory o = owner.sign(ownerLeaf++, _openDigest(a2.key(), p));
        vm.expectRevert(Hashgate.BadPolicy.selector);
        hg.openSession(vaultId, a2.key(), p, o);
    }
}
