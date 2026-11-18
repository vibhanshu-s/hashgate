import { encodeFunctionData, erc20Abi, isHex, maxUint256, type Hex } from "viem";
import { hashgateAbi, TUSD8 } from "@hashgate/sdk";
import { DRIP_AMOUNT, HASHGATE } from "@/lib/config";
import { clientIp, json, publicClient, rateLimit, relayerAccount, sendAndWait } from "@/lib/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const dripped = new Set<string>();

/** Funds a brand-new demo vault with 0.05 tUSD8 from the demo treasury, so visitors need no wallet. */
export async function POST(req: Request) {
  const ip = clientIp(req);
  const { vaultId } = (await req.json().catch(() => ({}))) as { vaultId?: string };
  if (!vaultId || !isHex(vaultId) || vaultId.length !== 66) return json({ ok: false, message: "Bad vault id." }, 400);
  if (dripped.has(vaultId)) return json({ ok: false, message: "This vault already got its demo funds." }, 400);
  if (!rateLimit(`drip:${ip}`, 3, 24 * 60 * 60 * 1000)) {
    return json({ ok: false, message: "Demo funds are limited to 3 vaults per network per day. Deposit tUSD8 with a wallet instead." }, 429);
  }
  const [, balance, sessions, exists] = await publicClient.readContract({
    address: HASHGATE, abi: hashgateAbi, functionName: "getVault", args: [vaultId as Hex],
  });
  if (!exists) return json({ ok: false, message: "Vault not found on-chain yet." }, 404);
  if (balance > 0n || sessions > 0) return json({ ok: false, message: "Only brand-new, empty vaults get demo funds." }, 400);

  const treasury = relayerAccount().address;
  const have = await publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [treasury] });
  if (have < DRIP_AMOUNT * 4n) {
    return json({ ok: false, message: "The demo treasury is nearly empty. Deposit tUSD8 from your own wallet instead." }, 503);
  }
  dripped.add(vaultId);
  try {
    const allowance = await publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "allowance", args: [treasury, HASHGATE] });
    if (allowance < DRIP_AMOUNT) {
      await sendAndWait(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [HASHGATE, maxUint256] }), TUSD8);
    }
    const { hash, receipt } = await sendAndWait(
      encodeFunctionData({ abi: hashgateAbi, functionName: "deposit", args: [vaultId as Hex, DRIP_AMOUNT] }),
    );
    return json({ ok: receipt.status === "success", hash, amount: DRIP_AMOUNT });
  } catch (e) {
    dripped.delete(vaultId);
    return json({ ok: false, message: (e as Error).message?.slice(0, 200) ?? "Drip failed." }, 502);
  }
}
