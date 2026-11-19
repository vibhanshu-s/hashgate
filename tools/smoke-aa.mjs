// Live ERC-4337 smoke test on Aevum through QDay's bundler (bundler.qday.info):
// account → owner-signed openSession UserOp → agent-signed payment UserOp → refused redirect →
// owner revoke → refused payment. Every UserOperation is signed with WOTS, sponsored by HashgatePaymaster.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, erc20Abi, keccak256, toHex, parseUnits, decodeErrorResult, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  KeyTree, randomSeed, aevum, TUSD8, ENTRY_POINT_V07, QDAY_BUNDLER_URL, ROLE_OWNER, ROLE_SESSION, accountCalls,
  accountSessionIdOf, dummyAccountSignature, encodeAccountSignature, userOpHash, toRpcUserOp,
  hashgateAccountAbi, hashgateAccountFactoryAbi,
} from "../packages/sdk/dist/index.js";

const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const dep = JSON.parse(readFileSync(new URL("../deployments/aevum.json", import.meta.url)));
const { accountFactory: FACTORY, paymaster: PAYMASTER } = dep.aa;
const relayer = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const pub = createPublicClient({ chain: aevum, transport: http() });
const w = createWalletClient({ chain: aevum, transport: http(), account: relayer });
const usd = (x) => parseUnits(String(x), 6);
const epAbi = [{ type: "function", name: "getNonce", stateMutability: "view", inputs: [{ name: "sender", type: "address" }, { name: "key", type: "uint192" }], outputs: [{ type: "uint256" }] }];

let rpcId = 0;
async function bundler(method, params) {
  const res = await fetch(QDAY_BUNDLER_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const body = await res.json();
  if (body.error) {
    const e = new Error(body.error.message);
    e.data = body.error.data;
    throw e;
  }
  return body.result;
}
function reason(e) {
  const hex = JSON.stringify(e.data ?? "").match(/0x[0-9a-fA-F]{8,}/g)?.pop() ?? e.message.match(/0x[0-9a-fA-F]{8,}/g)?.pop();
  let name = "";
  if (hex) { try { name = decodeErrorResult({ abi: hashgateAccountAbi, data: hex }).errorName; } catch {} }
  return `${e.message.slice(0, 160)}${name ? `  →  ${name}` : ""}`;
}

async function sendOp({ sender, callData, role, sessionId, tree, leaf }) {
  const nonce = await pub.readContract({ address: ENTRY_POINT_V07, abi: epAbi, functionName: "getNonce", args: [sender, 0n] });
  const prio = BigInt(await bundler("rundler_maxPriorityFeePerGas", []));
  const block = await pub.getBlock();
  const maxPriorityFeePerGas = (prio * 12n) / 10n;
  const maxFeePerGas = (block.baseFeePerGas ?? 0n) * 2n + maxPriorityFeePerGas;
  const op = {
    sender, nonce, callData, maxFeePerGas, maxPriorityFeePerGas,
    callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
    paymaster: PAYMASTER, paymasterVerificationGasLimit: 60000n, paymasterPostOpGasLimit: 0n, paymasterData: "0x",
    signature: dummyAccountSignature(role, sessionId, tree.height, leaf),
  };
  const est = await bundler("eth_estimateUserOperationGas", [toRpcUserOp(op), ENTRY_POINT_V07]);
  op.preVerificationGas = (BigInt(est.preVerificationGas) * 11n) / 10n;
  op.verificationGasLimit = (BigInt(est.verificationGasLimit) * 13n) / 10n + 30000n;
  op.callGasLimit = (BigInt(est.callGasLimit) * 12n) / 10n + 10000n;
  op.paymasterVerificationGasLimit = BigInt(est.paymasterVerificationGasLimit ?? 60000n) + 10000n;
  const hash = userOpHash(op, aevum.id);
  op.signature = encodeAccountSignature(role, sessionId, tree.sign(leaf, hash));
  const uoh = await bundler("eth_sendUserOperation", [toRpcUserOp(op), ENTRY_POINT_V07]);
  for (let i = 0; i < 60; i++) {
    const r = await bundler("eth_getUserOperationReceipt", [uoh]).catch(() => null);
    if (r) return { uoh, tx: r.receipt.transactionHash, success: r.success, gas: BigInt(r.actualGasUsed), est };
    await new Promise((s) => setTimeout(s, 1000));
  }
  throw new Error(`no receipt for ${uoh}`);
}
const log = (label, r) => console.log(`${label.padEnd(26)} ${r.success ? "ok " : "FAILED"} gas=${r.gas}  userOp=${r.uoh.slice(0, 12)}…  https://explorer-test.qday.info/tx/${r.tx}`);

// 1. account (factory tx by the relayer) + fund it with tUSD8
const owner = KeyTree.fromSeed(randomSeed(), 4);
const salt = randomSeed();
const account = getAddress(await pub.readContract({ address: FACTORY, abi: hashgateAccountFactoryAbi, functionName: "getAddress", args: [owner.commitment(), salt] }));
let h = await w.writeContract({ address: FACTORY, abi: hashgateAccountFactoryAbi, functionName: "createAccount", args: [owner.commitment(), salt], type: "legacy" });
await pub.waitForTransactionReceipt({ hash: h, pollingInterval: 1000 });
console.log("account", account, "created  tx", h);
h = await w.writeContract({ address: TUSD8, abi: erc20Abi, functionName: "transfer", args: [account, usd(0.02)], type: "legacy" });
await pub.waitForTransactionReceipt({ hash: h, pollingInterval: 1000 });

// 2. owner opens a session (UserOp via bundler)
const agent = KeyTree.fromSeed(randomSeed(), 3);
const sid = accountSessionIdOf(account, agent.commitment());
const VENDOR = getAddress("0xac3E000000000000000000000000000000C10ad1");
const EVIL = getAddress("0xBaDBadBAd0000000000000000000000000000BAd");
const exp = BigInt(Math.floor(Date.now() / 1000) + 3600);
const ZERO = `0x${"00".repeat(32)}`;
log("owner: openSession", await sendOp({ sender: account, callData: accountCalls.openSession(agent.commitment(), usd(0.01), usd(0.015), exp, [VENDOR]), role: ROLE_OWNER, sessionId: ZERO, tree: owner, leaf: 0 }));

// 3. agent pays the vendor
const memo = keccak256(toHex("INV-AA-1"));
const paid = await sendOp({ sender: account, callData: accountCalls.agentPay(sid, VENDOR, usd(0.005), memo), role: ROLE_SESSION, sessionId: sid, tree: agent, leaf: 0 });
log("agent: pay vendor", paid);
console.log("   bundler estimate", paid.est);

// 4. agent tries to pay the attacker → bundler rejects at validation
try {
  await sendOp({ sender: account, callData: accountCalls.agentPay(sid, EVIL, usd(0.005), memo), role: ROLE_SESSION, sessionId: sid, tree: agent, leaf: 1 });
  console.log("agent: pay attacker        UNEXPECTEDLY ACCEPTED");
} catch (e) { console.log("agent: pay attacker        rejected:", reason(e)); }

// 5. owner revokes; agent's next payment is rejected
log("owner: revokeSession", await sendOp({ sender: account, callData: accountCalls.revokeSession(sid), role: ROLE_OWNER, sessionId: ZERO, tree: owner, leaf: 1 }));
try {
  await sendOp({ sender: account, callData: accountCalls.agentPay(sid, VENDOR, usd(0.001), memo), role: ROLE_SESSION, sessionId: sid, tree: agent, leaf: 2 });
  console.log("agent: pay after revoke    UNEXPECTEDLY ACCEPTED");
} catch (e) { console.log("agent: pay after revoke    rejected:", reason(e)); }

// 6. Q-Day: an attacker's WOTS key tries to withdraw → signature failure
try {
  const attacker = KeyTree.fromSeed(randomSeed(), 4);
  await sendOp({ sender: account, callData: accountCalls.withdraw(TUSD8, EVIL, usd(0.01)), role: ROLE_OWNER, sessionId: ZERO, tree: attacker, leaf: 5 });
  console.log("attacker: withdraw         UNEXPECTEDLY ACCEPTED");
} catch (e) { console.log("attacker: withdraw         rejected:", reason(e)); }

const bal = await pub.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [account] });
console.log("account tUSD8 left", Number(bal) / 1e6);
