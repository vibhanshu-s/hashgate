import { defineChain, type Chain } from "viem";

/** QDay Aevum testnet. HTTPS only (no WebSocket); eth_getLogs is capped at 1,000 blocks. */
export const aevum: Chain = defineChain({
  id: 44005,
  name: "QDay Aevum Testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc-test.qday.info"] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: "https://explorer-test.qday.info" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export const TUSD8 = "0x456569838f1d43009A91ebA4263147Afd7233483" as const;
export const TUSD8_DECIMALS = 6;
export const LOG_BLOCK_LIMIT = 1000n;

export const explorerTx = (hash: string) => `https://explorer-test.qday.info/tx/${hash}`;
export const explorerAddress = (a: string) => `https://explorer-test.qday.info/address/${a}`;
