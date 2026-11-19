import { erc20Abi, formatEther, formatUnits } from "viem";
import { TUSD8 } from "@hashgate/sdk";
import { HASHGATE, PAYMASTER } from "@/lib/config";

const epAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
import { json, publicClient, relayerAccount } from "@/lib/server";

export const runtime = "nodejs";
export const revalidate = 0;

export async function GET() {
  try {
    const relayer = relayerAccount().address;
    const [block, gas, usd, vaultUsd, pmDeposit] = await Promise.all([
      publicClient.getBlockNumber(),
      publicClient.getBalance({ address: relayer }),
      publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [relayer] }),
      publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [HASHGATE] }),
      publicClient.readContract({ address: "0x0000000071727De22E5E9d8BAf0edAc6f37da032", abi: epAbi, functionName: "balanceOf", args: [PAYMASTER] }),
    ]);
    return json({
      ok: true, block, relayer, hashgate: HASHGATE,
      relayerGas: formatEther(gas), treasuryUsd: formatUnits(usd, 6), lockedUsd: formatUnits(vaultUsd, 6), paymaster: PAYMASTER, paymasterDeposit: formatEther(pmDeposit),
    });
  } catch (e) {
    return json({ ok: false, message: (e as Error).message.slice(0, 200) }, 503);
  }
}
