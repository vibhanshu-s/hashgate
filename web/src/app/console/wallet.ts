"use client";
import { createWalletClient, custom, encodeFunctionData, parseSignature, type Hex } from "viem";
import { aevum, depositNonce, hashgateAbi, randomSeed, TUSD8 } from "@hashgate/sdk";
import { HASHGATE } from "@/lib/config";

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

/**
 * Gasless deposit: the user signs an EIP-3009 ReceiveWithAuthorization in their wallet, bound to
 * this vault through the nonce, and the relayer submits it. This is the one ECDSA step in Hashgate:
 * it moves funds *into* the post-quantum vault.
 */
export async function depositWithWallet(vaultId: Hex, amount: bigint, say: (m: string) => void): Promise<Hex> {
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
  const salt = randomSeed();
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
  say("Sign the deposit authorization in your wallet");
  const sig = await wallet.signTypedData({
    account: from,
    domain: { name: "tUSD8", version: "2", chainId: aevum.id, verifyingContract: TUSD8 },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    message: { from, to: HASHGATE, value: amount, validAfter: 0n, validBefore, nonce: depositNonce(HASHGATE, vaultId, salt) },
  });
  const { r, s, v, yParity } = parseSignature(sig);
  return encodeFunctionData({
    abi: hashgateAbi,
    functionName: "depositWithAuthorization",
    args: [vaultId, from, amount, 0n, validBefore, salt, Number(v ?? BigInt(yParity + 27)), r, s],
  });
}
