import "server-only";
import {
  BaseError, createPublicClient, createWalletClient, decodeErrorResult, http, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { aevum, hashgateAbi } from "@hashgate/sdk";
import { HASHGATE } from "./config";

export const publicClient = createPublicClient({ chain: aevum, transport: http(undefined, { retryCount: 3, timeout: 20_000 }) });

// Anvil/Hardhat default keys are public; never let them hold anything on a real network.
const PUBLIC_TEST_KEYS = new Set([
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
]);

export function relayerAccount() {
  const k = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
  if (!k) throw new Error("Relayer is not configured (RELAYER_PRIVATE_KEY).");
  if (PUBLIC_TEST_KEYS.has(k.toLowerCase())) throw new Error("Refusing a public test key on Aevum.");
  return privateKeyToAccount(k);
}

export function walletClient() {
  return createWalletClient({ chain: aevum, transport: http(undefined, { retryCount: 2, timeout: 20_000 }), account: relayerAccount() });
}

/** Extracts a Hashgate custom error (name + args) from any viem error, if there is one. */
export function decodeRevert(e: unknown): { name: string; args?: readonly unknown[] } | null {
  if (!(e instanceof BaseError)) return null;
  const decoded = e.walk((x) => !!(x as { data?: { errorName?: string } }).data?.errorName) as
    | { data: { errorName: string; args?: readonly unknown[] } }
    | null;
  if (decoded) return { name: decoded.data.errorName, args: decoded.data.args };
  const raw = e.walk((x) => {
    const d = (x as { data?: unknown }).data;
    return typeof d === "string" && d.startsWith("0x") && d.length >= 10;
  }) as { data: Hex } | null;
  if (!raw) return null;
  try {
    const r = decodeErrorResult({ abi: hashgateAbi, data: raw.data });
    return { name: r.errorName, args: r.args };
  } catch {
    return null;
  }
}

// One relayer key, many requests: serialise sends within this instance so nonces don't collide.
let queue: Promise<unknown> = Promise.resolve();
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/** Simulates, sends a legacy tx to Hashgate (or `to`), retries once on nonce races, waits for the receipt. */
export async function sendAndWait(data: Hex, to: Hex = HASHGATE, fixedGas?: bigint) {
  const account = relayerAccount();
  const gas = fixedGas ?? (await publicClient.estimateGas({ account, to, data }));
  const hash = await serial(async () => {
    const w = walletClient();
    const gasPrice = await publicClient.getGasPrice();
    for (let attempt = 0; ; attempt++) {
      const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
      try {
        return await w.sendTransaction({ to, data, gas: fixedGas ?? (gas * 12n) / 10n + 10_000n, gasPrice, nonce, type: "legacy" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < 2 && /nonce|already known|underpriced/i.test(msg)) continue;
        throw e;
      }
    }
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 1000, timeout: 45_000 });
  return { hash, receipt };
}

// In-memory rate limits. On serverless each instance has its own copy, so they slow abuse rather
// than stop it; the relayer holds only a little tQDAY. Move to Redis for production.
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) {
    buckets.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  if (b.n >= max) return false;
  b.n++;
  return true;
}

export function clientIp(req: Request): string {
  const h = process.env.TRUSTED_IP_HEADER || "x-forwarded-for";
  return (req.headers.get(h) || "local").split(",")[0].trim();
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
