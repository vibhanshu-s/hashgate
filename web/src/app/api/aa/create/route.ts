import { encodeFunctionData, erc20Abi, getAddress, isHex, type Hex } from "viem";
import { TUSD8, hashgateAccountFactoryAbi } from "@hashgate/sdk";
import { ACCOUNT_FACTORY, DRIP_AMOUNT } from "@/lib/config";
import { clientIp, json, publicClient, rateLimit, relayerAccount, sendAndWait } from "@/lib/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type Key = { pubSeed: Hex; root: Hex; height: number };

/**
 * Deploys a HashgateAccount clone for an owner key commitment (the factory call needs no
 * signature: committing to your own public key grants nothing) and drips 0.05 test tUSD8 into it.
 * Gas for everything after this is sponsored by HashgatePaymaster through the QDay bundler.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  const { key, salt } = (await req.json().catch(() => ({}))) as { key?: Key; salt?: string };
  if (!key || !isHex(key.pubSeed) || !isHex(key.root) || !(key.height >= 1 && key.height <= 12) || !salt || !isHex(salt)) {
    return json({ ok: false, message: "Bad key commitment." }, 400);
  }
  if (!rateLimit(`create:${ip}`, 8, 24 * 60 * 60 * 1000)) return json({ ok: false, message: "Account creation is limited per network per day." }, 429);
  const k = { pubSeed: key.pubSeed, root: key.root, height: key.height };
  const account = getAddress(await publicClient.readContract({ address: ACCOUNT_FACTORY, abi: hashgateAccountFactoryAbi, functionName: "getAddress", args: [k, salt as Hex] }));
  try {
    const created = await sendAndWait(encodeFunctionData({ abi: hashgateAccountFactoryAbi, functionName: "createAccount", args: [k, salt as Hex] }), ACCOUNT_FACTORY);
    let drip: { hash?: Hex; message?: string } = {};
    const have = await publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [relayerAccount().address] });
    if (!rateLimit(`drip:${ip}`, 5, 24 * 60 * 60 * 1000)) drip = { message: "Demo funds are limited to 5 accounts per network per day. Send tUSD8 to the account from a wallet." };
    else if (have < DRIP_AMOUNT * 4n) drip = { message: "The demo treasury is nearly empty. Send tUSD8 to the account from a wallet." };
    else {
      const d = await sendAndWait(encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [account, DRIP_AMOUNT] }), TUSD8);
      drip = { hash: d.hash };
    }
    return json({ ok: created.receipt.status === "success", account, hash: created.hash, drip, amount: DRIP_AMOUNT });
  } catch (e) {
    return json({ ok: false, message: (e as Error).message.slice(0, 200) }, 502);
  }
}
