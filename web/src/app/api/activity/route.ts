import { decodeEventLog, type Hex } from "viem";
import { hashgateAbi } from "@hashgate/sdk";
import { DEPLOY_BLOCK, HASHGATE } from "@/lib/config";
import { json, publicClient } from "@/lib/server";

export const runtime = "nodejs";
export const revalidate = 0;

type RawLog = { blockNumber: string; data: Hex; topics: (Hex | null)[]; transactionHash: Hex; timeStamp: string; logIndex: string };

/**
 * Hashgate events, newest first. Reads Aevum's Blockscout log API (no 1,000-block cap) and falls
 * back to RPC eth_getLogs over the latest 1,000-block window if the explorer is unavailable.
 */
export async function GET(req: Request) {
  const vault = new URL(req.url).searchParams.get("vault")?.toLowerCase();
  let logs: { blockNumber: bigint; data: Hex; topics: Hex[]; transactionHash: Hex; timestamp?: number; logIndex: number }[] = [];
  let source = "explorer";
  try {
    const url = `https://explorer-test.qday.info/api?module=logs&action=getLogs&fromBlock=${DEPLOY_BLOCK}&toBlock=latest&address=${HASHGATE}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    const body = (await res.json()) as { result?: RawLog[] };
    if (!Array.isArray(body.result)) throw new Error("explorer returned no result");
    logs = body.result.map((l) => ({
      blockNumber: BigInt(l.blockNumber), data: l.data, topics: l.topics.filter(Boolean) as Hex[],
      transactionHash: l.transactionHash, timestamp: Number(BigInt(l.timeStamp)), logIndex: Number(BigInt(l.logIndex || "0x0")),
    }));
  } catch {
    source = "rpc";
    const latest = await publicClient.getBlockNumber();
    const from = latest - 999n > DEPLOY_BLOCK ? latest - 999n : DEPLOY_BLOCK;
    const raw = await publicClient.getLogs({ address: HASHGATE, fromBlock: from, toBlock: latest });
    logs = raw.map((l) => ({ blockNumber: l.blockNumber!, data: l.data, topics: l.topics as Hex[], transactionHash: l.transactionHash!, logIndex: l.logIndex ?? 0 }));
  }
  const events = logs
    .map((l) => {
      try {
        const d = decodeEventLog({ abi: hashgateAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        return { event: d.eventName, args: d.args as Record<string, unknown>, block: l.blockNumber, tx: l.transactionHash, time: l.timestamp, logIndex: l.logIndex };
      } catch {
        return null;
      }
    })
    .filter((e): e is NonNullable<typeof e> => !!e)
    .filter((e) => !vault || String(e.args.vaultId ?? "").toLowerCase() === vault)
    .sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : Number(b.block - a.block)))
    .slice(0, 200);
  return json({ ok: true, source, events });
}
