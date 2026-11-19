// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Hashgate} from "../src/Hashgate.sol";
import {HashgateAccount} from "../src/aa/HashgateAccount.sol";
import {HashgateAccountFactory} from "../src/aa/HashgateAccountFactory.sol";
import {HashgatePaymaster} from "../src/aa/HashgatePaymaster.sol";
import {IEntryPoint, PackedUserOperation} from "../src/aa/IEntryPoint.sol";
import {MockUSD8} from "./mocks/MockUSD8.sol";
import {WOTSSigner} from "./WOTSSigner.sol";

/// Unit tests: the test contract plays the EntryPoint (the account only checks msg.sender).
/// Fork test (`forge test --fork-url https://rpc-test.qday.info`): the real EntryPoint v0.7 on Aevum.
contract HashgateAccountTest is Test {
    address constant EP = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    MockUSD8 tok;
    HashgateAccountFactory factory;
    HashgateAccount account;
    WOTSSigner owner;
    WOTSSigner agent;
    bytes32 sid;
    address vendor = address(0xA1);
    address evil = address(0xDEAD);
    uint32 ownerLeaf;

    function _k(WOTSSigner s) internal view returns (HashgateAccount.Key memory k) {
        Hashgate.Key memory h = s.key();
        k = HashgateAccount.Key(h.pubSeed, h.root, h.height);
    }

    function _sig(WOTSSigner s, uint8 role, bytes32 sessionId, uint32 leaf, bytes32 hash) internal view returns (bytes memory) {
        Hashgate.OTS memory o = s.sign(leaf, hash);
        return abi.encode(role, sessionId, HashgateAccount.OTS(o.leafIndex, o.sig, o.path));
    }

    function _op(bytes memory callData, bytes memory signature) internal view returns (PackedUserOperation memory op) {
        op.sender = address(account);
        op.callData = callData;
        op.signature = signature;
    }

    function setUp() public {
        tok = new MockUSD8();
        HashgateAccount impl = new HashgateAccount(IEntryPoint(address(this)), address(tok));
        factory = new HashgateAccountFactory(impl);
        owner = new WOTSSigner(keccak256("owner"), 3);
        agent = new WOTSSigner(keccak256("agent"), 2);
        account = factory.createAccount(_k(owner), bytes32(uint256(1)));
        tok.mint(address(account), 1e6);

        HashgateAccount.Key memory ak = _k(agent);
        sid = account.sessionIdOf(ak);
        address[] memory payees = new address[](1);
        payees[0] = vendor;
        bytes memory open = abi.encodeCall(HashgateAccount.openSession, (ak, 0.02e6, 0.04e6, uint48(block.timestamp + 1 hours), payees));
        bytes32 h = keccak256("open");
        assertEq(account.validateUserOp(_op(open, _sig(owner, 0, 0, ownerLeaf++, h)), h, 0), 0);
        (bool ok,) = address(account).call(open);
        assertTrue(ok);
    }

    function test_factoryIsDeterministic() public view {
        assertEq(factory.getAddress(_k(owner), bytes32(uint256(1))), address(account));
        assertEq(keccak256(address(account).code), factory.cloneRuntimeCodeHash());
    }

    function test_sessionPayReturnsExpiryAsValidUntil() public {
        bytes memory pay = abi.encodeCall(HashgateAccount.agentPay, (sid, vendor, 0.01e6, bytes32("INV")));
        bytes32 h = keccak256("p0");
        uint256 vd = account.validateUserOp(_op(pay, _sig(agent, 1, sid, 0, h)), h, 0);
        assertEq(vd >> 160, block.timestamp + 1 hours);
        assertEq(vd & 1, 0);
        account.agentPay(sid, vendor, 0.01e6, bytes32("INV"));
        assertEq(tok.balanceOf(vendor), 0.01e6);
    }

    function test_forgedSignatureFailsWithoutBurningLeaf() public {
        WOTSSigner attacker = new WOTSSigner(keccak256("attacker"), 3);
        bytes memory steal = abi.encodeCall(HashgateAccount.execute, (address(tok), 0, abi.encodeCall(MockUSD8.transfer, (evil, 1e6))));
        bytes32 h = keccak256("steal");
        assertEq(account.validateUserOp(_op(steal, _sig(attacker, 0, 0, 5, h)), h, 0), 1);
        (HashgateAccount.Key memory k,) = account.ownerKey();
        assertFalse(account.isLeafUsed(k, 5));
    }

    function test_sessionPolicyEnforcedInValidation() public {
        bytes32 h = keccak256("x");
        bytes memory toEvil = abi.encodeCall(HashgateAccount.agentPay, (sid, evil, 0.01e6, bytes32(0)));
        vm.expectRevert(abi.encodeWithSelector(HashgateAccount.PayeeNotAllowed.selector, evil));
        account.validateUserOp(_op(toEvil, _sig(agent, 1, sid, 0, h)), h, 0);

        bytes memory tooMuch = abi.encodeCall(HashgateAccount.agentPay, (sid, vendor, 0.03e6, bytes32(0)));
        vm.expectRevert(abi.encodeWithSelector(HashgateAccount.OverPerPaymentCap.selector, 0.03e6, 0.02e6));
        account.validateUserOp(_op(tooMuch, _sig(agent, 1, sid, 0, h)), h, 0);

        bytes memory steal = abi.encodeCall(HashgateAccount.execute, (address(tok), 0, ""));
        vm.expectRevert(HashgateAccount.SessionMayOnlyPay.selector);
        account.validateUserOp(_op(steal, _sig(agent, 1, sid, 0, h)), h, 0);
    }

    function test_revokeAndLeafReuse() public {
        bytes32 h = keccak256("r");
        bytes memory revoke = abi.encodeCall(HashgateAccount.revokeSession, (sid));
        assertEq(account.validateUserOp(_op(revoke, _sig(owner, 0, 0, ownerLeaf, h)), h, 0), 0);
        vm.expectRevert(abi.encodeWithSelector(HashgateAccount.LeafAlreadyUsed.selector, ownerLeaf));
        account.validateUserOp(_op(revoke, _sig(owner, 0, 0, ownerLeaf, h)), h, 0);
        account.revokeSession(sid);
        bytes memory pay = abi.encodeCall(HashgateAccount.agentPay, (sid, vendor, 0.01e6, bytes32(0)));
        vm.expectRevert(HashgateAccount.SessionIsRevoked.selector);
        account.validateUserOp(_op(pay, _sig(agent, 1, sid, 0, h)), h, 0);
    }

    function test_onlyEntryPoint() public {
        vm.prank(evil);
        vm.expectRevert(HashgateAccount.NotEntryPoint.selector);
        account.execute(address(tok), 0, "");
    }

    /// Full path through the real EntryPoint v0.7 on an Aevum fork, gas sponsored by HashgatePaymaster.
    function test_fork_handleOpsWithRealEntryPoint() public {
        if (EP.code.length == 0) return; // not on a fork
        HashgateAccount impl = new HashgateAccount(IEntryPoint(EP), address(tok));
        HashgateAccountFactory f = new HashgateAccountFactory(impl);
        HashgatePaymaster pm = new HashgatePaymaster(IEntryPoint(EP), f.cloneRuntimeCodeHash(), 0.05 ether);
        vm.deal(address(this), 1 ether);
        pm.deposit{value: 0.5 ether}();
        HashgateAccount acct = f.createAccount(_k(owner), bytes32(uint256(7)));
        tok.mint(address(acct), 1e6);

        HashgateAccount.Key memory ak = _k(agent);
        address[] memory payees = new address[](1);
        payees[0] = vendor;
        PackedUserOperation memory op;
        op.sender = address(acct);
        op.nonce = 0;
        op.callData = abi.encodeCall(HashgateAccount.openSession, (ak, 0.02e6, 0.04e6, uint48(block.timestamp + 1 hours), payees));
        op.accountGasLimits = bytes32((uint256(700_000) << 128) | 300_000);
        op.preVerificationGas = 120_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 2 gwei);
        op.paymasterAndData = abi.encodePacked(address(pm), uint128(80_000), uint128(0));
        bytes32 h = IEntryPoint(EP).getUserOpHash(op);
        op.signature = _sig(owner, 0, 0, 0, h);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        IEntryPoint(EP).handleOps(ops, payable(address(0xBEEF)));
        bytes32 s = acct.sessionIdOf(ak);
        (HashgateAccount.Session memory sess,) = acct.getSession(s);
        assertTrue(sess.exists);

        op.nonce = 1;
        op.callData = abi.encodeCall(HashgateAccount.agentPay, (s, vendor, 0.01e6, bytes32("INV")));
        op.signature = "";
        h = IEntryPoint(EP).getUserOpHash(op);
        op.signature = _sig(agent, 1, s, 0, h);
        ops[0] = op;
        IEntryPoint(EP).handleOps(ops, payable(address(0xBEEF)));
        assertEq(tok.balanceOf(vendor), 0.01e6);
    }

    receive() external payable {}
}
