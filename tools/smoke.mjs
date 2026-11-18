// Live smoke test on Aevum: vault → deposit → session → paid → blocked (simulated) → revoke → refused.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, erc20Abi, maxUint256, keccak256, toHex, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { KeyTree, randomSeed, hashgateAbi, aevum, domainOf, vaultIdOf, sessionIdOf, openSessionDigest, payDigest, revokeDigest, TUSD8 } from "../packages/sdk/dist/index.js";

const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/).filter(Boolean).map((l) => l.split("=")));
const dep = JSON.parse(readFileSync(new URL("../deployments/aevum.json", import.meta.url)));
const HG = dep.hashgate;
const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const pub = createPublicClient({ chain: aevum, transport: http() });
const w = createWalletClient({ chain: aevum, transport: http(), account });
const usd = (x) => parseUnits(String(x), 6);
const send = async (address, abi, functionName, args) => {
  const hash = await w.writeContract({ address, abi, functionName, args, type: "legacy" });
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 1000 });
  console.log(`${functionName.padEnd(14)} ${r.status} gas=${r.gasUsed} https://explorer-test.qday.info/tx/${hash}`);
  return r;
};
const why = async (functionName, args) => {
  try { await pub.simulateContract({ address: HG, abi: hashgateAbi, functionName, args, account }); return "passed?!"; }
  catch (e) { return e.walk((x) => x.data?.errorName)?.data?.errorName ?? e.shortMessage; }
};

const domain = domainOf(44005, HG);
const owner = KeyTree.fromSeed(randomSeed(), 3);
const salt = randomSeed();
const vaultId = vaultIdOf(owner.commitment(), salt);
await send(HG, hashgateAbi, "createVault", [owner.commitment(), salt]);
await send(TUSD8, erc20Abi, "approve", [HG, maxUint256]);
await send(HG, hashgateAbi, "deposit", [vaultId, usd(0.03)]);
const agent = KeyTree.fromSeed(randomSeed(), 3);
const policy = { maxPerPayment: usd(0.01), budget: usd(0.02), expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600), payees: ["0xac3E000000000000000000000000000000C10ad1"] };
await send(HG, hashgateAbi, "openSession", [vaultId, agent.commitment(), policy, owner.sign(0, openSessionDigest(domain, vaultId, agent.commitment(), policy))]);
const sid = sessionIdOf(vaultId, agent.commitment());
const memo = keccak256(toHex("SMOKE-1"));
await send(HG, hashgateAbi, "pay", [sid, policy.payees[0], usd(0.005), memo, agent.sign(0, payDigest(domain, sid, policy.payees[0], usd(0.005), memo))]);
const evil = "0xBaDBadBAd0000000000000000000000000000BAd";
console.log("redirect to attacker ->", await why("pay", [sid, evil, usd(0.005), memo, agent.sign(1, payDigest(domain, sid, evil, usd(0.005), memo))]));
await send(HG, hashgateAbi, "revokeSession", [sid, owner.sign(1, revokeDigest(domain, sid))]);
console.log("after revoke ->", await why("pay", [sid, policy.payees[0], usd(0.001), memo, agent.sign(2, payDigest(domain, sid, policy.payees[0], usd(0.001), memo))]));
