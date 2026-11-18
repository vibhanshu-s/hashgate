import { decodeFunctionData, isHex, type Hex } from "viem";
import { hashgateAbi, explainError } from "@hashgate/sdk";
import { HASHGATE } from "@/lib/config";
import { clientIp, decodeRevert, json, publicClient, rateLimit, relayerAccount, sendAndWait } from "@/lib/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// The relayer only ever calls these Hashgate functions. Authorisation lives in the WOTS
// signatures inside the calldata, so the relayer cannot change what was signed.
const ALLOWED = new Set([
  "createVault", "openSession", "revokeSession", "withdraw", "rotateOwnerKey", "pay", "depositWithAuthorization",
]);

export async function POST(req: Request) {
  const ip = clientIp(req);
  if (!rateLimit(`relay:${ip}`, 40, 60 * 60 * 1000)) {
    return json({ ok: false, error: "RateLimited", message: "Too many requests from your network. Try again in an hour." }, 429);
  }
  let body: { data?: string; simulateOnly?: boolean; force?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "BadRequest", message: "Body must be JSON." }, 400);
  }
  const data = body.data;
  if (!data || !isHex(data) || data.length > 20_000) {
    return json({ ok: false, error: "BadRequest", message: "Missing or oversized calldata." }, 400);
  }
  let fn: string;
  try {
    fn = decodeFunctionData({ abi: hashgateAbi, data: data as Hex }).functionName;
  } catch {
    return json({ ok: false, error: "BadRequest", message: "Calldata is not a Hashgate call." }, 400);
  }
  if (!ALLOWED.has(fn)) return json({ ok: false, error: "NotAllowed", message: `The relayer does not submit ${fn}.` }, 400);

  // Demo only: submit a payment the contract will refuse, so the refusal is a real, failed
  // transaction anyone can inspect on the explorer. Limited to `pay`, fixed gas, tight rate limit.
  if (body.force) {
    if (fn !== "pay") return json({ ok: false, error: "NotAllowed", message: "Only payments can be force-submitted." }, 400);
    if (!rateLimit(`force:${ip}`, 6, 60 * 60 * 1000)) return json({ ok: false, error: "RateLimited", message: "Too many forced submissions." }, 429);
    try {
      const { hash, receipt } = await sendAndWait(data as Hex, HASHGATE, 450_000n);
      return json({ ok: receipt.status === "success", stage: "mined", fn, hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed, forced: true });
    } catch (e) {
      return json({ ok: false, stage: "send", fn, error: "RpcError", message: shortMsg(e) }, 502);
    }
  }

  // Simulate first: a call that would revert never costs gas, and the user gets the exact reason.
  try {
    await publicClient.call({ account: relayerAccount().address, to: HASHGATE, data: data as Hex });
  } catch (e) {
    const r = decodeRevert(e);
    if (r) return json({ ok: false, stage: "simulation", fn, error: r.name, args: r.args, message: explainError(r.name) }, 200);
    return json({ ok: false, stage: "simulation", fn, error: "RpcError", message: shortMsg(e) }, 502);
  }
  if (body.simulateOnly) return json({ ok: true, stage: "simulation", fn });

  try {
    const { hash, receipt } = await sendAndWait(data as Hex);
    return json({
      ok: receipt.status === "success", stage: "mined", fn, hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed,
      ...(receipt.status !== "success" ? { error: "Reverted", message: "The transaction reverted on-chain." } : {}),
    });
  } catch (e) {
    const r = decodeRevert(e);
    if (r) return json({ ok: false, stage: "send", fn, error: r.name, message: explainError(r.name) }, 200);
    return json({ ok: false, stage: "send", fn, error: "RpcError", message: shortMsg(e) }, 502);
  }
}

function shortMsg(e: unknown) {
  const m = e instanceof Error ? (e as { shortMessage?: string }).shortMessage || e.message : String(e);
  return m.slice(0, 300);
}
