// HashgateAccount (ERC-4337) logic on an in-process Shanghai EVM. The test wallet plays the
// EntryPoint (the account only checks msg.sender), so validateUserOp and execution are called
// directly. The real EntryPoint + QDay bundler path is exercised by tools/smoke-aa.mjs on Aevum.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  BaseError, ContractFunctionRevertedError, decodeErrorResult, createPublicClient, createWalletClient, custom, decodeFunctionResult,
  encodeFunctionData, getAddress, keccak256, parseUnits, toHex, zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  KeyTree, randomSeed, hashgateAccountAbi, hashgateAccountFactoryAbi, hashgatePaymasterAbi, accountCalls,
  accountSessionIdOf, encodeAccountSignature, ROLE_OWNER, ROLE_SESSION,
} from "../dist/index.js";

const require = createRequire(import.meta.url);
const hre = require("hardhat");
const art = (n) => JSON.parse(readFileSync(new URL(`../../../contracts/out/${n}.json`, import.meta.url)));
const chain = { id: 31337, name: "hardhat", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://x"] } } };
const transport = custom(hre.network.provider);
const pub = createPublicClient({ chain, transport });
const ep = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"); // plays the EntryPoint
const stranger = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const wallet = createWalletClient({ chain, transport, account: ep });
const usd = (x) => parseUnits(String(x), 6);
const VENDOR = getAddress("0x00000000000000000000000000000000000000a1");
const EVIL = getAddress("0x000000000000000000000000000000000000dead");

async function deploy(name, args = []) {
  const a = art(name);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
}
const op = (sender, callData, signature) => ({
  sender, nonce: 0n, initCode: "0x", callData, accountGasLimits: `0x${"00".repeat(32)}`, preVerificationGas: 0n,
  gasFees: `0x${"00".repeat(32)}`, paymasterAndData: "0x", signature,
});
/** Calls validateUserOp as the EntryPoint; returns validationData, or the custom error name. */
async function validate(account, callData, signature, hash) {
  try {
    const { result } = await pub.simulateContract({ address: account, abi: hashgateAccountAbi, functionName: "validateUserOp", args: [op(account, callData, signature), hash, 0n], account: ep });
    await wallet.writeContract({ address: account, abi: hashgateAccountAbi, functionName: "validateUserOp", args: [op(account, callData, signature), hash, 0n] });
    return result;
  } catch (e) {
    const r = e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r?.data?.errorName) return r.data.errorName;
    const raw = String(e.message).match(/return data: (0x[0-9a-fA-F]+)/)?.[1];
    if (raw) return decodeErrorResult({ abi: hashgateAccountAbi, data: raw }).errorName;
    throw e;
  }
}
async function exec(account, callData) {
  const hash = await wallet.sendTransaction({ to: account, data: callData });
  return pub.waitForTransactionReceipt({ hash });
}
const h = (s) => keccak256(toHex(s)); // stands in for a userOpHash

test("HashgateAccount: factory, owner ops, session policy in validation, expiry as validUntil", async (t) => {
  const tok = await deploy("MockUSD8");
  const impl = await deploy("HashgateAccount", [ep.address, tok]);
  const factory = await deploy("HashgateAccountFactory", [impl]);

  const owner = KeyTree.fromSeed(randomSeed(), 3);
  const salt = randomSeed();
  const predicted = await pub.readContract({ address: factory, abi: hashgateAccountFactoryAbi, functionName: "getAddress", args: [owner.commitment(), salt] });
  await wallet.writeContract({ address: factory, abi: hashgateAccountFactoryAbi, functionName: "createAccount", args: [owner.commitment(), salt] });
  const account = predicted;
  assert.ok((await pub.getCode({ address: account }))?.length > 2, "clone deployed at the predicted address");

  const codehash = keccak256(await pub.getCode({ address: account }));
  const expected = await pub.readContract({ address: factory, abi: hashgateAccountFactoryAbi, functionName: "cloneRuntimeCodeHash" });
  assert.equal(codehash, expected, "paymaster can recognise clones by code hash");

  await wallet.writeContract({ address: tok, abi: art("MockUSD8").abi, functionName: "mint", args: [account, usd(1)] });

  const agent = KeyTree.fromSeed(randomSeed(), 3);
  const sid = accountSessionIdOf(account, agent.commitment());
  const now = (await pub.getBlock()).timestamp;
  const expiresAt = now + 3600n;
  const openData = accountCalls.openSession(agent.commitment(), usd(0.02), usd(0.04), expiresAt, [VENDOR]);

  await t.test("owner op: valid WOTS signature → 0, forged → SIG_VALIDATION_FAILED, reuse → LeafAlreadyUsed", async () => {
    const forger = KeyTree.fromSeed(randomSeed(), 3);
    assert.equal(await validate(account, openData, encodeAccountSignature(ROLE_OWNER, `0x${"00".repeat(32)}`, forger.sign(0, h("open"))), h("open")), 1n);
    assert.equal(await validate(account, openData, encodeAccountSignature(ROLE_OWNER, `0x${"00".repeat(32)}`, owner.sign(0, h("open"))), h("open")), 0n);
    assert.equal(await validate(account, openData, encodeAccountSignature(ROLE_OWNER, `0x${"00".repeat(32)}`, owner.sign(0, h("other"))), h("other")), "LeafAlreadyUsed");
    const r = await exec(account, openData);
    assert.equal(r.status, "success");
  });

  const pay = (to, amt) => accountCalls.agentPay(sid, to, amt, h("INV-1"));
  await t.test("session op: within policy → validUntil = expiry; refusals revert in validation", async () => {
    const vd = await validate(account, pay(VENDOR, usd(0.01)), encodeAccountSignature(ROLE_SESSION, sid, agent.sign(0, h("p0"))), h("p0"));
    assert.equal(vd >> 160n, expiresAt, "expiry is returned as validUntil, no TIMESTAMP in validation");
    assert.equal(vd & 1n, 0n);
    const r = await exec(account, pay(VENDOR, usd(0.01)));
    assert.equal(r.status, "success");
    assert.equal(await validate(account, pay(EVIL, usd(0.01)), encodeAccountSignature(ROLE_SESSION, sid, agent.sign(1, h("p1"))), h("p1")), "PayeeNotAllowed");
    assert.equal(await validate(account, pay(VENDOR, usd(0.03)), encodeAccountSignature(ROLE_SESSION, sid, agent.sign(1, h("p2"))), h("p2")), "OverPerPaymentCap");
    // a session key may only call agentPay
    const steal = accountCalls.withdraw(tok, EVIL, usd(0.5));
    assert.equal(await validate(account, steal, encodeAccountSignature(ROLE_SESSION, sid, agent.sign(1, h("p3"))), h("p3")), "SessionMayOnlyPay");
  });

  await t.test("revoke kills the session in validation", async () => {
    await exec(account, accountCalls.revokeSession(sid));
    assert.equal(await validate(account, pay(VENDOR, usd(0.01)), encodeAccountSignature(ROLE_SESSION, sid, agent.sign(2, h("p4"))), h("p4")), "SessionIsRevoked");
  });

  await t.test("owner withdraw through execute", async () => {
    await exec(account, accountCalls.withdraw(tok, stranger.address, usd(0.5)));
    const bal = await pub.readContract({ address: tok, abi: art("MockUSD8").abi, functionName: "balanceOf", args: [stranger.address] });
    assert.equal(bal, usd(0.5));
  });

  await t.test("only the EntryPoint can call execution functions", async () => {
    const w2 = createWalletClient({ chain, transport, account: stranger });
    await assert.rejects(w2.writeContract({ address: account, abi: hashgateAccountAbi, functionName: "execute", args: [tok, 0n, "0x"] }));
  });

  await t.test("paymaster sponsors Hashgate accounts only", async () => {
    const pm = await deploy("HashgatePaymaster", [ep.address, codehash, parseUnits("0.01", 18)]);
    const call = (sender, maxCost) => pub.call({ account: ep.address, to: pm, data: encodeFunctionData({ abi: hashgatePaymasterAbi, functionName: "validatePaymasterUserOp", args: [op(sender, "0x", "0x"), h("x"), maxCost] }) });
    const ok = await call(account, 1000n);
    assert.ok(decodeFunctionResult({ abi: hashgatePaymasterAbi, functionName: "validatePaymasterUserOp", data: ok.data }));
    await assert.rejects(call(stranger.address, 1000n), /NotHashgateAccount|revert/);
    await assert.rejects(call(account, parseUnits("1", 18)), /TooExpensive|revert/);
    void zeroAddress;
  });
});
