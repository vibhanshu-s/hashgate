// End-to-end tests: the TypeScript signer against the real Hashgate bytecode on an in-process
// Shanghai EVM (Hardhat network). Run with `npm test` from the repo root.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, custom, decodeErrorResult, parseUnits, keccak256, toHex, getAddress,
  BaseError, ContractFunctionRevertedError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  KeyTree, randomSeed, verifyOTS, hashgateAbi, domainOf, vaultIdOf, sessionIdOf, openSessionDigest, payDigest,
  revokeDigest, withdrawDigest, rotateDigest, depositNonce, digits,
} from "../dist/index.js";

const require = createRequire(import.meta.url);
const hre = require("hardhat");
const art = (n) => JSON.parse(readFileSync(new URL(`../../../contracts/out/${n}.json`, import.meta.url)));

const chain = { id: 31337, name: "hardhat", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://x"] } } };
const transport = custom(hre.network.provider);
const pub = createPublicClient({ chain, transport });
// Hardhat's default account #0 (public test key), plus a "buyer" with its own key for EIP-3009.
const relayer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const buyer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const wallet = createWalletClient({ chain, transport, account: relayer });
const usd = (x) => parseUnits(String(x), 6);
const PAYEE = getAddress("0x00000000000000000000000000000000000000a1");
const EVIL = getAddress("0x000000000000000000000000000000000000dead");

async function deploy(name, args = []) {
  const a = art(name);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  return { address: r.contractAddress, abi: a.abi };
}
async function send(c, fn, args) {
  const hash = await wallet.writeContract({ address: c.address, abi: c.abi, functionName: fn, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", `${fn} failed`);
  return r;
}
async function revertName(c, fn, args) {
  try {
    await pub.simulateContract({ address: c.address, abi: c.abi, functionName: fn, args, account: relayer });
  } catch (e) {
    if (e instanceof BaseError) {
      const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
      if (r?.data?.errorName) return r.data.errorName;
      const raw = e.walk((x) => x.data && typeof x.data === "string");
      if (raw?.data) return decodeErrorResult({ abi: hashgateAbi, data: raw.data }).errorName;
    }
    throw e;
  }
  return null;
}

test("WOTS digits: checksum digits are correct", () => {
  const d = digits(new Uint8Array(32)); // all zero -> checksum 960 = 0x3c0
  assert.equal(d.length, 67);
  assert.deepEqual(d.slice(64), [3, 12, 0]);
});

test("off-chain sign/verify roundtrip and tamper detection", () => {
  const t = KeyTree.fromSeed(randomSeed(), 3);
  const digest = keccak256(toHex("hello"));
  const ots = t.sign(5, digest);
  assert.ok(verifyOTS(t.commitment(), digest, ots));
  assert.ok(!verifyOTS(t.commitment(), keccak256(toHex("hellp")), ots), "other digest must fail");
  assert.ok(!verifyOTS(t.commitment(), digest, { ...ots, leafIndex: 4 }), "other leaf must fail");
  const bad = ots.sig.slice(0, 10) + (ots.sig[10] === "0" ? "1" : "0") + ots.sig.slice(11);
  assert.ok(!verifyOTS(t.commitment(), digest, { ...ots, sig: bad }), "flipped bit must fail");
  // cache rebuild gives same root
  const t2 = KeyTree.fromCache(randomSeed(), 3, t.leafCache());
  assert.equal(t2.commitment().root, t.commitment().root);
});

test("Hashgate end to end on a Shanghai EVM", async (t) => {
  const tok = await deploy("MockUSD8");
  const hg = await deploy("Hashgate", [tok.address]);
  const domain = await pub.readContract({ address: hg.address, abi: hg.abi, functionName: "domain" });
  assert.equal(domain, domainOf(31337, hg.address), "SDK domain matches contract");

  const owner = KeyTree.fromSeed(randomSeed(), 4);
  const salt = randomSeed();
  const vaultId = vaultIdOf(owner.commitment(), salt);
  await send(hg, "createVault", [owner.commitment(), salt]);
  assert.equal(await revertName(hg, "createVault", [owner.commitment(), salt]), "VaultExists");

  // fund: relayer approve + deposit 10
  await send(tok, "mint", [relayer.address, usd(100)]);
  await send(tok, "approve", [hg.address, usd(100)]);
  await send(hg, "deposit", [vaultId, usd(10)]);

  // open a session: cap 1, budget 2.5, payee allowlist [PAYEE]
  const agent = KeyTree.fromSeed(randomSeed(), 3);
  const now = (await pub.getBlock()).timestamp;
  const policy = { maxPerPayment: usd(1), budget: usd(2.5), expiresAt: now + 3600n, payees: [PAYEE] };
  const sessionId = sessionIdOf(vaultId, agent.commitment());
  const openSig = owner.sign(0, openSessionDigest(domain, vaultId, agent.commitment(), policy));
  // a forged owner signature: signed over a different policy
  const forged = owner.sign(1, openSessionDigest(domain, vaultId, agent.commitment(), { ...policy, budget: usd(9) }));
  assert.equal(await revertName(hg, "openSession", [vaultId, agent.commitment(), policy, forged]), "BadSignature");
  await send(hg, "openSession", [vaultId, agent.commitment(), policy, openSig]);
  assert.equal(await revertName(hg, "openSession", [vaultId, agent.commitment(), policy, openSig]), "LeafAlreadyUsed");

  const memo = keccak256(toHex("INV-1"));
  const paySig = (leaf, to, amt) => agent.sign(leaf, payDigest(domain, sessionId, to, amt, memo));

  await t.test("allowed payment settles and is measured", async () => {
    const r = await send(hg, "pay", [sessionId, PAYEE, usd(0.75), memo, paySig(0, PAYEE, usd(0.75))]);
    console.log(`      gas used by a post-quantum agent payment: ${r.gasUsed}`);
    assert.ok(r.gasUsed < 400000n);
    assert.equal(await pub.readContract({ address: tok.address, abi: tok.abi, functionName: "balanceOf", args: [PAYEE] }), usd(0.75));
  });
  await t.test("policy blocks: payee, per-payment cap, budget, replay, forgery", async () => {
    assert.equal(await revertName(hg, "pay", [sessionId, EVIL, usd(0.5), memo, paySig(1, EVIL, usd(0.5))]), "PayeeNotAllowed");
    assert.equal(await revertName(hg, "pay", [sessionId, PAYEE, usd(1.5), memo, paySig(1, PAYEE, usd(1.5))]), "OverPerPaymentCap");
    assert.equal(await revertName(hg, "pay", [sessionId, PAYEE, usd(0.5), memo, paySig(0, PAYEE, usd(0.5))]), "LeafAlreadyUsed");
    // signature for 0.1 replayed with amount 0.9 -> BadSignature
    assert.equal(await revertName(hg, "pay", [sessionId, PAYEE, usd(0.9), memo, paySig(1, PAYEE, usd(0.1))]), "BadSignature");
    await send(hg, "pay", [sessionId, PAYEE, usd(1), memo, paySig(1, PAYEE, usd(1))]);
    assert.equal(await revertName(hg, "pay", [sessionId, PAYEE, usd(1), memo, paySig(2, PAYEE, usd(1))]), "OverBudget");
    const code = await pub.readContract({ address: hg.address, abi: hg.abi, functionName: "checkPayment", args: [sessionId, EVIL, usd(0.1)] });
    assert.equal(code, 6);
  });
  await t.test("ECDSA has no power: relayer cannot withdraw without a WOTS signature", async () => {
    const wrongKey = KeyTree.fromSeed(randomSeed(), 4);
    const sig = wrongKey.sign(9, withdrawDigest(domain, vaultId, relayer.address, usd(1), owner.commitment().root));
    assert.equal(await revertName(hg, "withdraw", [vaultId, relayer.address, usd(1), sig]), "BadSignature");
  });
  await t.test("owner revokes; next agent payment fails", async () => {
    await send(hg, "revokeSession", [sessionId, owner.sign(2, revokeDigest(domain, sessionId))]);
    assert.equal(await revertName(hg, "pay", [sessionId, PAYEE, usd(0.1), memo, paySig(3, PAYEE, usd(0.1))]), "SessionIsRevoked");
  });
  await t.test("expiry", async () => {
    const a2 = KeyTree.fromSeed(randomSeed(), 2);
    const now2 = (await pub.getBlock()).timestamp;
    const p2 = { maxPerPayment: usd(1), budget: usd(1), expiresAt: now2 + 60n, payees: [] };
    await send(hg, "openSession", [vaultId, a2.commitment(), p2, owner.sign(3, openSessionDigest(domain, vaultId, a2.commitment(), p2))]);
    const s2 = sessionIdOf(vaultId, a2.commitment());
    await hre.network.provider.send("evm_increaseTime", [120]);
    await hre.network.provider.send("evm_mine", []);
    assert.equal(await revertName(hg, "pay", [s2, EVIL, usd(0.1), memo, a2.sign(0, payDigest(domain, s2, EVIL, usd(0.1), memo))]), "SessionExpired");
  });
  await t.test("owner withdraws and rotates key", async () => {
    const before = await pub.readContract({ address: tok.address, abi: tok.abi, functionName: "balanceOf", args: [buyer.address] });
    await send(hg, "withdraw", [vaultId, buyer.address, usd(2), owner.sign(4, withdrawDigest(domain, vaultId, buyer.address, usd(2), owner.commitment().root))]);
    const after = await pub.readContract({ address: tok.address, abi: tok.abi, functionName: "balanceOf", args: [buyer.address] });
    assert.equal(after - before, usd(2));
    const owner2 = KeyTree.fromSeed(randomSeed(), 3);
    await send(hg, "rotateOwnerKey", [vaultId, owner2.commitment(), owner.sign(5, rotateDigest(domain, vaultId, owner2.commitment()))]);
    // old key is dead now
    assert.equal(await revertName(hg, "withdraw", [vaultId, buyer.address, usd(1), owner.sign(6, withdrawDigest(domain, vaultId, buyer.address, usd(1), owner2.commitment().root))]), "BadSignature");
    await send(hg, "withdraw", [vaultId, buyer.address, usd(1), owner2.sign(0, withdrawDigest(domain, vaultId, buyer.address, usd(1), owner2.commitment().root))]);
  });
  await t.test("gasless deposit via EIP-3009 bound to the vault", async () => {
    await send(tok, "mint", [buyer.address, usd(5)]);
    const dsalt = randomSeed();
    const now3 = (await pub.getBlock()).timestamp;
    const msg = { from: buyer.address, to: hg.address, value: usd(3), validAfter: 0n, validBefore: now3 + 3600n, nonce: depositNonce(hg.address, vaultId, dsalt) };
    const sig = await buyer.signTypedData({
      domain: { name: "tUSD8", version: "2", chainId: 31337, verifyingContract: tok.address },
      types: { ReceiveWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "ReceiveWithAuthorization", message: msg,
    });
    const r = `0x${sig.slice(2, 66)}`, s = `0x${sig.slice(66, 130)}`, v = parseInt(sig.slice(130, 132), 16);
    // relayer tries to credit a different vault with the same signature -> token rejects
    await assert.rejects(pub.simulateContract({ address: hg.address, abi: hg.abi, functionName: "depositWithAuthorization", args: [vaultId, buyer.address, usd(3), 0n, msg.validBefore, randomSeed(), v, r, s], account: relayer }));
    await send(hg, "depositWithAuthorization", [vaultId, buyer.address, usd(3), 0n, msg.validBefore, dsalt, v, r, s]);
    const [, bal] = await pub.readContract({ address: hg.address, abi: hg.abi, functionName: "getVault", args: [vaultId] });
    assert.equal(bal, usd(10) - usd(1.75) - usd(3) + usd(3));
  });
});
