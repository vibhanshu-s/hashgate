// Deploys HashgateAccount (implementation), HashgateAccountFactory and HashgatePaymaster to Aevum,
// and funds the paymaster's EntryPoint deposit. Reads DEPLOYER_PRIVATE_KEY from .env.local.
// Usage: node tools/deploy-aa.mjs [depositTQDAY=0.3]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = new URL("..", import.meta.url);
if (!process.env.DEPLOYER_PRIVATE_KEY && existsSync(new URL(".env.local", root))) {
  for (const l of readFileSync(new URL(".env.local", root), "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2];
  }
}
const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483";
const chain = { id: 44005, name: "QDay Aevum Testnet", nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc-test.qday.info"] } } };
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const pub = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ chain, transport: http(), account });
const art = (n) => JSON.parse(readFileSync(new URL(`contracts/out/${n}.json`, root)));

async function deploy(name, args) {
  const a = art(name);
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args, type: "legacy" });
  const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 1000 });
  if (r.status !== "success") throw new Error(`${name} deploy failed`);
  console.log(`${name.padEnd(24)} ${r.contractAddress}  gas ${r.gasUsed}  tx ${hash}`);
  return { address: r.contractAddress, tx: hash, block: Number(r.blockNumber) };
}

const impl = await deploy("HashgateAccount", [ENTRY_POINT, TUSD8]);
const factory = await deploy("HashgateAccountFactory", [impl.address]);
const codehash = await pub.readContract({ address: factory.address, abi: art("HashgateAccountFactory").abi, functionName: "cloneRuntimeCodeHash" });
const paymaster = await deploy("HashgatePaymaster", [ENTRY_POINT, codehash, parseEther("0.005")]);

const deposit = parseEther(process.argv[2] ?? "0.3");
const dHash = await wallet.writeContract({ address: paymaster.address, abi: art("HashgatePaymaster").abi, functionName: "deposit", value: deposit, type: "legacy" });
await pub.waitForTransactionReceipt({ hash: dHash, pollingInterval: 1000 });
console.log("paymaster deposit", process.argv[2] ?? "0.3", "tQDAY  tx", dHash);

const file = new URL("deployments/aevum.json", root);
const prev = JSON.parse(readFileSync(file, "utf8"));
prev.aa = {
  entryPoint: ENTRY_POINT,
  bundler: "https://bundler.qday.info",
  accountImplementation: impl.address,
  accountFactory: factory.address,
  paymaster: paymaster.address,
  accountCodehash: codehash,
  deployBlock: impl.block,
  txs: { implementation: impl.tx, factory: factory.tx, paymaster: paymaster.tx, deposit: dHash },
};
writeFileSync(file, JSON.stringify(prev, null, 2));
