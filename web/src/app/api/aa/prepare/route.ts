import { getAddress, isAddress, isHex, keccak256, type Address, type Hex } from "viem";
import { ENTRY_POINT_V07, dummyAccountSignature, toRpcUserOp, userOpHash, type UserOp } from "@hashgate/sdk";
import { ACCOUNT_IMPLEMENTATION, CHAIN_ID, PAYMASTER } from "@/lib/config";
import { bundlerRpc, entryPointNonce, explainBundler, fees } from "@/lib/aa-server";
import { clientIp, json, publicClient, rateLimit } from "@/lib/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const CLONE = `0x363d3d373d3d3d363d73${ACCOUNT_IMPLEMENTATION.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;

/**
 * Builds an unsigned UserOperation for a Hashgate account: nonce, fees, paymaster, and gas limits
 * from the QDay bundler's estimate (run with a same-length dummy WOTS signature). The browser
 * checks the result and signs the userOpHash itself.
 */
export async function POST(req: Request) {
  if (!rateLimit(`prepare:${clientIp(req)}`, 80, 60 * 60 * 1000)) return json({ ok: false, error: "RateLimited", message: "Too many requests. Try again later." }, 429);
  const b = (await req.json().catch(() => ({}))) as { sender?: string; callData?: string; role?: number; sessionId?: string; height?: number; leaf?: number; force?: boolean };
  if (!b.sender || !isAddress(b.sender) || !b.callData || !isHex(b.callData) || b.callData.length > 4000 || (b.role !== 0 && b.role !== 1)) {
    return json({ ok: false, error: "BadRequest", message: "Missing sender, callData or role." }, 400);
  }
  const sender = getAddress(b.sender) as Address;
  const code = await publicClient.getCode({ address: sender });
  if (code?.toLowerCase() !== CLONE) return json({ ok: false, error: "NotHashgateAccount", message: "That address is not a Hashgate account." }, 400);
  const sessionId = (b.sessionId && isHex(b.sessionId) ? b.sessionId : `0x${"00".repeat(32)}`) as Hex;
  const height = Math.min(Math.max(Number(b.height) || 5, 1), 12);

  const [nonce, fee] = await Promise.all([entryPointNonce(sender), fees()]);
  const op: UserOp = {
    sender, nonce, callData: b.callData as Hex, ...fee,
    callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n,
    paymaster: PAYMASTER, paymasterVerificationGasLimit: 60_000n, paymasterPostOpGasLimit: 0n, paymasterData: "0x",
    signature: dummyAccountSignature(b.role, sessionId, height, Number(b.leaf) || 0),
  };
  let est: { preVerificationGas: string; verificationGasLimit: string; callGasLimit: string; paymasterVerificationGasLimit?: string };
  if (b.force) {
    // Recording a refusal on-chain: the bundler won't estimate an op that fails validation, so use
    // fixed limits; the relayer submits it with EntryPoint.handleOps and it reverts on-chain.
    est = { preVerificationGas: "0x1d4c0", verificationGasLimit: "0x61a80", callGasLimit: "0x249f0", paymasterVerificationGasLimit: "0xea60" };
  } else try {
    est = await bundlerRpc("eth_estimateUserOperationGas", [toRpcUserOp(op), ENTRY_POINT_V07]);
  } catch (e) {
    const r = explainBundler(e);
    return json({ ok: false, stage: "validation", ...r });
  }
  // Margins: WOTS cost varies a little with the digest, and the dummy signature is not the real one.
  op.preVerificationGas = (BigInt(est.preVerificationGas) * 11n) / 10n;
  op.verificationGasLimit = (BigInt(est.verificationGasLimit) * 13n) / 10n + 30_000n;
  op.callGasLimit = (BigInt(est.callGasLimit) * 12n) / 10n + 10_000n;
  op.paymasterVerificationGasLimit = BigInt(est.paymasterVerificationGasLimit ?? "0xea60") + 10_000n;
  op.signature = "0x";
  return json({ ok: true, op: toRpcUserOp(op), userOpHash: userOpHash(op, CHAIN_ID), codeHash: keccak256(code) });
}
