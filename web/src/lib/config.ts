import { getAddress, type Address } from "viem";

export const HASHGATE = getAddress(
  process.env.NEXT_PUBLIC_HASHGATE_ADDRESS || "0x0000000000000000000000000000000000000000",
) as Address;
export const DEPLOY_BLOCK = BigInt(process.env.NEXT_PUBLIC_DEPLOY_BLOCK || "0");
export const CHAIN_ID = 44005;
export const REPO_URL = "https://github.com/vibhanshu-s/hashgate";

/** Demo vendors. Addresses are fixed, key-less "sink" addresses so the demo is reproducible. */
export const VENDORS = [
  { name: "Acme Cloud", address: getAddress("0xac3e000000000000000000000000000000c10ad1"), note: "GPU hours" },
  { name: "Paper & Ink Co.", address: getAddress("0x9a9e400000000000000000000000000000001c0a"), note: "Office supplies" },
  { name: "DataFeed API", address: getAddress("0xda7af00d0000000000000000000000000000fead"), note: "Market data" },
] as const;

/** The address a prompt-injected invoice tries to redirect money to. */
export const ATTACKER = getAddress("0xbadbadbad0000000000000000000000000000bad");

export const DRIP_AMOUNT = 50_000n; // 0.05 tUSD8 (6 decimals)

export function vendorName(a: string): string | undefined {
  const l = a.toLowerCase();
  if (l === ATTACKER.toLowerCase()) return "Unknown (attacker)";
  return VENDORS.find((v) => v.address.toLowerCase() === l)?.name;
}
