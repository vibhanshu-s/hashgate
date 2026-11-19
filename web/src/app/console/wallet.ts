"use client";
import { createWalletClient, custom, erc20Abi, type Address, type Hex } from "viem";
import { aevum, TUSD8 } from "@hashgate/sdk";

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

/** Sends tUSD8 from the user's browser wallet into their Hashgate account (a plain ERC-20 transfer). */
export async function depositWithWallet(account: Address, amount: bigint, say: (m: string) => void): Promise<Hex> {
  const eth = (globalThis as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error("No browser wallet found. Install MetaMask or Rabby, or use the demo funds.");
  const wallet = createWalletClient({ chain: aevum, transport: custom(eth) });
  const [from] = await wallet.requestAddresses();
  try {
    await wallet.switchChain({ id: aevum.id });
  } catch {
    say("Adding QDay Aevum testnet to your wallet");
    await wallet.addChain({ chain: aevum });
  }
  say("Confirm the tUSD8 transfer in your wallet");
  return wallet.writeContract({ account: from, chain: aevum, address: TUSD8, abi: erc20Abi, functionName: "transfer", args: [account, amount] });
}
