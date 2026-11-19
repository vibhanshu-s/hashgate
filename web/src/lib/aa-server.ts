import "server-only";
import { decodeErrorResult, encodeFunctionData, type Address, type Hex } from "viem";
import {
  ENTRY_POINT_V07, QDAY_BUNDLER_URL, AA_ERRORS, explainError, fromRpcUserOp, hashgateAccountAbi, hashgatePaymasterAbi,
  type UserOp,
} from "@hashgate/sdk";
import { publicClient, relayerAccount, sendAndWait } from "./server";

const BUNDLER = process.env.BUNDLER_URL || QDAY_BUNDLER_URL;

export class BundlerError extends Error {
  constructor(message: string, public data?: unknown, public transport = false) {
    super(message);
  }
}

let rpcId = 0;
export async function bundlerRpc<T>(method: string, params: unknown[]): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BUNDLER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new BundlerError(`Bundler unreachable: ${(e as Error).message}`, undefined, true);
  }
  if (res.status >= 500) throw new BundlerError(`Bundler HTTP ${res.status}`, undefined, true);
  const body = (await res.json()) as { result?: T; error?: { message: string; data?: unknown } };
  if (body.error) throw new BundlerError(body.error.message, body.error.data);
  return body.result as T;
}

/** Turns a bundler / EntryPoint rejection into { code, error, message } in plain language. */
export function explainBundler(e: unknown): { error: string; code?: string; message: string } {
  const raw = e instanceof BundlerError ? e : new BundlerError(String((e as Error)?.message ?? e));
  const text = `${raw.message} ${JSON.stringify(raw.data ?? "")}`;
  const code = text.match(/AA\d\d/)?.[0];
  const hexes = text.match(/0x[0-9a-fA-F]{8,}/g) ?? [];
  for (const h of hexes.reverse()) {
    for (const abi of [hashgateAccountAbi, hashgatePaymasterAbi]) {
      try {
        const name = decodeErrorResult({ abi, data: h as Hex }).errorName;
        return { error: name, code, message: explainError(name) };
      } catch {}
    }
  }
  if (/Invalid account signature|signature error/i.test(text)) return { error: "BadSignature", code: code ?? "AA24", message: AA_ERRORS.AA24 };
  if (/nonce/i.test(text)) return { error: "InvalidNonce", code: code ?? "AA25", message: AA_ERRORS.AA25 };
  if (code && AA_ERRORS[code]) return { error: code, code, message: AA_ERRORS[code] };
  return { error: "BundlerRejected", code, message: raw.message.slice(0, 240) };
}

export async function fees() {
  const [prio, block] = await Promise.all([
    bundlerRpc<string>("rundler_maxPriorityFeePerGas", []).catch(() => "0x3b9aca00"),
    publicClient.getBlock(),
  ]);
  const maxPriorityFeePerGas = (BigInt(prio) * 12n) / 10n;
  return { maxPriorityFeePerGas, maxFeePerGas: (block.baseFeePerGas ?? 0n) * 2n + maxPriorityFeePerGas };
}

const epAbi = [
  { type: "function", name: "getNonce", stateMutability: "view", inputs: [{ name: "sender", type: "address" }, { name: "key", type: "uint192" }], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "handleOps", stateMutability: "nonpayable",
    inputs: [
      {
        name: "ops", type: "tuple[]",
        components: [
          { name: "sender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "initCode", type: "bytes" },
          { name: "callData", type: "bytes" }, { name: "accountGasLimits", type: "bytes32" }, { name: "preVerificationGas", type: "uint256" },
          { name: "gasFees", type: "bytes32" }, { name: "paymasterAndData", type: "bytes" }, { name: "signature", type: "bytes" },
        ],
      },
      { name: "beneficiary", type: "address" },
    ],
    outputs: [],
  },
] as const;

export async function entryPointNonce(sender: Address) {
  return publicClient.readContract({ address: ENTRY_POINT_V07, abi: epAbi, functionName: "getNonce", args: [sender, 0n] });
}

const pack16 = (a: bigint, b: bigint) => `0x${a.toString(16).padStart(32, "0")}${b.toString(16).padStart(32, "0")}` as Hex;

/** Packs a v0.7 op and submits EntryPoint.handleOps from the relayer (fallback, or forced on-chain refusal). */
export async function selfBundle(o: Record<string, string>, fixedGas?: bigint) {
  const op = fromRpcUserOp(o) as UserOp;
  const paymasterAndData = op.paymaster
    ? (`${op.paymaster}${(op.paymasterVerificationGasLimit ?? 0n).toString(16).padStart(32, "0")}${(op.paymasterPostOpGasLimit ?? 0n).toString(16).padStart(32, "0")}${(op.paymasterData ?? "0x").slice(2)}` as Hex)
    : "0x";
  const packed = {
    sender: op.sender, nonce: op.nonce, initCode: (op.factory ? `${op.factory}${(op.factoryData ?? "0x").slice(2)}` : "0x") as Hex,
    callData: op.callData, accountGasLimits: pack16(op.verificationGasLimit, op.callGasLimit), preVerificationGas: op.preVerificationGas,
    gasFees: pack16(op.maxPriorityFeePerGas, op.maxFeePerGas), paymasterAndData, signature: op.signature,
  };
  const data = encodeFunctionData({ abi: epAbi, functionName: "handleOps", args: [[packed], relayerAccount().address] });
  return sendAndWait(data, ENTRY_POINT_V07, fixedGas);
}
