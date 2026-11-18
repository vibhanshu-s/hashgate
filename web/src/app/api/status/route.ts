import { erc20Abi, formatEther, formatUnits } from "viem";
import { TUSD8 } from "@hashgate/sdk";
import { HASHGATE } from "@/lib/config";
import { json, publicClient, relayerAccount } from "@/lib/server";

export const runtime = "nodejs";
export const revalidate = 0;

export async function GET() {
  try {
    const relayer = relayerAccount().address;
    const [block, gas, usd, vaultUsd] = await Promise.all([
      publicClient.getBlockNumber(),
      publicClient.getBalance({ address: relayer }),
      publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [relayer] }),
      publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [HASHGATE] }),
    ]);
    return json({
      ok: true, block, relayer, hashgate: HASHGATE,
      relayerGas: formatEther(gas), treasuryUsd: formatUnits(usd, 6), lockedUsd: formatUnits(vaultUsd, 6),
    });
  } catch (e) {
    return json({ ok: false, message: (e as Error).message.slice(0, 200) }, 503);
  }
}
