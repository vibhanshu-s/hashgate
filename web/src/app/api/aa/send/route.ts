import { ENTRY_POINT_V07, type UserOp } from "@hashgate/sdk";
import { BundlerError, bundlerRpc, explainBundler, selfBundle } from "@/lib/aa-server";
import { clientIp, json, rateLimit } from "@/lib/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type Receipt = { success: boolean; actualGasUsed: string; reason?: string; receipt: { transactionHash: string; blockNumber: string } };

/**
 * Sends a signed UserOperation to the QDay bundler and waits for its receipt.
 * - Rejections (validation, signature, nonce) come back as plain-language reasons.
 * - If the bundler is unreachable, the relayer submits EntryPoint.handleOps itself.
 * - force: the relayer submits handleOps directly even though validation will fail, so the
 *   refusal is a real reverted transaction on the explorer (demo of on-chain proof).
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`send:${ip}`, 60, 60 * 60 * 1000)) return json({ ok: false, error: "RateLimited", message: "Too many requests. Try again later." }, 429);
  const { op, force } = (await req.json().catch(() => ({}))) as { op?: Record<string, string>; force?: boolean };
  if (!op?.sender || !op.signature || op.signature.length > 8000) return json({ ok: false, error: "BadRequest", message: "Missing signed op." }, 400);

  if (force) {
    if (!rateLimit(`force:${ip}`, 6, 60 * 60 * 1000)) return json({ ok: false, error: "RateLimited", message: "Too many forced submissions." }, 429);
    try {
      const { hash, receipt } = await selfBundle(op, 900_000n);
      return json({ ok: receipt.status === "success", via: "relayer handleOps (forced)", hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed });
    } catch (e) {
      return json({ ok: false, error: "RpcError", message: (e as Error).message.slice(0, 240) }, 502);
    }
  }

  let uoh: string;
  try {
    uoh = await bundlerRpc<string>("eth_sendUserOperation", [op, ENTRY_POINT_V07]);
  } catch (e) {
    if (e instanceof BundlerError && e.transport) {
      // Bundler down: keep the demo working by bundling ourselves.
      try {
        const { hash, receipt } = await selfBundle(op);
        return json({ ok: receipt.status === "success", via: "relayer handleOps (bundler unreachable)", hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed });
      } catch (e2) {
        return json({ ok: false, stage: "send", ...explainBundler(e2) });
      }
    }
    return json({ ok: false, stage: "bundler", ...explainBundler(e) });
  }

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const r = await bundlerRpc<Receipt | null>("eth_getUserOperationReceipt", [uoh]).catch(() => null);
    if (r) {
      return json({
        ok: r.success, via: "QDay bundler", userOpHash: uoh, hash: r.receipt.transactionHash, block: BigInt(r.receipt.blockNumber),
        gasUsed: BigInt(r.actualGasUsed), ...(r.success ? {} : { error: "ExecutionReverted", message: "The operation was included but its call reverted." }),
      });
    }
    await new Promise((s) => setTimeout(s, 1000));
  }
  return json({ ok: false, userOpHash: uoh, error: "Timeout", message: "The bundler accepted the operation but it isn't mined yet. Check Activity in a minute." }, 504);
}

export type { UserOp };
