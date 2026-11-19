import { getAddress, type Address } from "viem";

export const HASHGATE = getAddress(
  process.env.NEXT_PUBLIC_HASHGATE_ADDRESS || "0x0000000000000000000000000000000000000000",
) as Address;
export const DEPLOY_BLOCK = BigInt(process.env.NEXT_PUBLIC_DEPLOY_BLOCK || "0");
export const CHAIN_ID = 44005;

// ERC-4337 deployment (EntryPoint v0.7, QDay bundler)
export const ACCOUNT_FACTORY = getAddress(process.env.NEXT_PUBLIC_ACCOUNT_FACTORY || "0x54cd8d534c187bf9d6db8a37c7b45e3ad1444b21") as Address;
export const PAYMASTER = getAddress(process.env.NEXT_PUBLIC_PAYMASTER || "0x48de838a3d18f8965edf8cb5db2517a92375809f") as Address;
export const ACCOUNT_IMPLEMENTATION = getAddress("0x24a1c67db3691230ab24c0ff6ce2f50d96150fba") as Address;
export const AA_DEPLOY_BLOCK = BigInt(process.env.NEXT_PUBLIC_AA_DEPLOY_BLOCK || "3560212");
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
