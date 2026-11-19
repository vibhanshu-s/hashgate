import { decodeEventLog, encodeEventTopics, type Abi, type Hex } from "viem";
import { hashgateAbi, hashgateAccountAbi, hashgateAccountFactoryAbi } from "@hashgate/sdk";
import { AA_DEPLOY_BLOCK, ACCOUNT_FACTORY, DEPLOY_BLOCK, HASHGATE } from "@/lib/config";
import { json, publicClient } from "@/lib/server";

export const runtime = "nodejs";
export const revalidate = 0;

type RawLog = { address: string; blockNumber: string; data: Hex; topics: (Hex | null)[]; transactionHash: Hex; timeStamp: string; logIndex: string };
type Log = { address: string; blockNumber: bigint; data: Hex; topics: Hex[]; transactionHash: Hex; timestamp?: number; logIndex: number };

const EXPLORER = "https://explorer-test.qday.info/api?module=logs&action=getLogs";

async function explorerLogs(query: string): Promise<Log[]> {
  const res = await fetch(`${EXPLORER}&${query}`, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
  const body = (await res.json()) as { result?: RawLog[] | string };
  if (!Array.isArray(body.result)) {
    if (body.result == null || /No (records|logs)/i.test(String((body as { message?: string }).message))) return [];
    throw new Error("explorer returned no result");
  }
  return body.result.map((l) => ({
    address: l.address.toLowerCase(), blockNumber: BigInt(l.blockNumber), data: l.data, topics: l.topics.filter(Boolean) as Hex[],
    transactionHash: l.transactionHash, timestamp: Number(BigInt(l.timeStamp)), logIndex: Number(BigInt(l.logIndex || "0x0")),
  }));
}

const topic = (name: string) => encodeEventTopics({ abi: hashgateAccountAbi as Abi, eventName: name })[0] as Hex;

/**
 * Hashgate events, newest first, from the Aevum Blockscout log API (no 1,000-block cap):
 * v2 ERC-4337 accounts (factory + every account's session/payment events) and the v1 vault.
 * Falls back to RPC eth_getLogs over the latest 1,000 blocks if the explorer is unavailable.
 */
export async function GET(req: Request) {
  const filter = new URL(req.url).searchParams.get("vault")?.toLowerCase();
  let logs: (Log & { kind: "account" | "vault" })[] = [];
  let source = "explorer";
  try {
    const [vault, created, ...accountLogs] = await Promise.all([
      explorerLogs(`fromBlock=${DEPLOY_BLOCK}&toBlock=latest&address=${HASHGATE}`),
      explorerLogs(`fromBlock=${AA_DEPLOY_BLOCK}&toBlock=latest&address=${ACCOUNT_FACTORY}`),
      ...["SessionOpened", "SessionRevoked", "AgentPaid", "Executed"].map((n) => explorerLogs(`fromBlock=${AA_DEPLOY_BLOCK}&toBlock=latest&topic0=${topic(n)}`)),
    ]);
    const accounts = new Set<string>();
    for (const l of created) {
      try {
        const d = decodeEventLog({ abi: hashgateAccountFactoryAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        if (d.eventName === "AccountCreated") accounts.add(String(d.args.account).toLowerCase());
      } catch {}
    }
    logs = [
      ...vault.map((l) => ({ ...l, kind: "vault" as const })),
      ...created.map((l) => ({ ...l, kind: "account" as const })),
      ...accountLogs.flat().filter((l) => accounts.has(l.address)).map((l) => ({ ...l, kind: "account" as const })),
    ];
  } catch {
    source = "rpc";
    const latest = await publicClient.getBlockNumber();
    const from = latest - 999n;
    const raw = await publicClient.getLogs({ address: [HASHGATE, ACCOUNT_FACTORY], fromBlock: from, toBlock: latest });
    logs = raw.map((l) => ({
      address: l.address.toLowerCase(), blockNumber: l.blockNumber!, data: l.data, topics: l.topics as Hex[], transactionHash: l.transactionHash!,
      logIndex: l.logIndex ?? 0, kind: l.address.toLowerCase() === HASHGATE.toLowerCase() ? ("vault" as const) : ("account" as const),
    }));
  }
  const events = logs
    .map((l) => {
      const abis = l.kind === "vault" ? [hashgateAbi] : [hashgateAccountAbi, hashgateAccountFactoryAbi];
      for (const abi of abis) {
        try {
          const d = decodeEventLog({ abi: abi as Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
          return { event: String(d.eventName), kind: l.kind, address: l.address, args: d.args as unknown as Record<string, unknown>, block: l.blockNumber, tx: l.transactionHash, time: l.timestamp, logIndex: l.logIndex };
        } catch {}
      }
      return null;
    })
    .filter((e): e is NonNullable<typeof e> => !!e)
    .filter((e) => !filter || e.address === filter || String(e.args.account ?? "").toLowerCase() === filter)
    .sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : Number(b.block - a.block)))
    .slice(0, 200);
  return json({ ok: true, source, events });
}
