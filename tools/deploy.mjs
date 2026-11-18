// Deploys Hashgate to QDay Aevum testnet with viem (legacy tx, as Aevum expects).
// Usage: DEPLOYER_PRIVATE_KEY=0x... node tools/deploy.mjs   (or put it in .env.local)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = new URL("..", import.meta.url);
if (!process.env.DEPLOYER_PRIVATE_KEY && existsSync(new URL(".env.local", root))) {
  for (const l of readFileSync(new URL(".env.local", root), "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2];
  }
}
const TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483";
const chain = { id: 44005, name: "QDay Aevum Testnet", nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc-test.qday.info"] } } };
const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const pub = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ chain, transport: http(), account });
const art = JSON.parse(readFileSync(new URL("contracts/out/Hashgate.json", root)));

const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [TUSD8], type: "legacy" });
console.log("tx", hash);
const r = await pub.waitForTransactionReceipt({ hash, pollingInterval: 1000 });
console.log("status", r.status, "address", r.contractAddress, "block", r.blockNumber, "gas", r.gasUsed);
const out = { network: "aevum-testnet", chainId: 44005, hashgate: r.contractAddress, token: TUSD8, deployTx: hash, deployBlock: Number(r.blockNumber), deployer: account.address };
writeFileSync(new URL("deployments/aevum.json", root), JSON.stringify(out, null, 2));
