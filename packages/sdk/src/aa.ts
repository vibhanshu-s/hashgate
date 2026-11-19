// ERC-4337 (EntryPoint v0.7) helpers for HashgateAccount: post-quantum UserOperations.
import { encodeAbiParameters, encodeFunctionData, erc20Abi, keccak256, pad, toHex, type Address, type Hex } from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
import { hashgateAccountAbi } from "./abi.js";
import type { KeyCommitment, OTS } from "./tree.js";

export const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;
/** QDay's rundler-based bundler (ERC-7562 safe mode). */
export const QDAY_BUNDLER_URL = "https://bundler.qday.info";

export const ROLE_OWNER = 0;
export const ROLE_SESSION = 1;

/** A v0.7 UserOperation in the unpacked JSON-RPC form bundlers accept. Numbers are bigint. */
export type UserOp = {
  sender: Address;
  nonce: bigint;
  factory?: Address;
  factoryData?: Hex;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymaster?: Address;
  paymasterVerificationGasLimit?: bigint;
  paymasterPostOpGasLimit?: bigint;
  paymasterData?: Hex;
  signature: Hex;
};

const OTS_TUPLE = {
  type: "tuple",
  components: [
    { name: "leafIndex", type: "uint32" },
    { name: "sig", type: "bytes" },
    { name: "path", type: "bytes32[]" },
  ],
} as const;

/** signature = abi.encode(uint8 role, bytes32 sessionId, OTS ots) — what HashgateAccount.validateUserOp decodes. */
export function encodeAccountSignature(role: number, sessionId: Hex, ots: OTS): Hex {
  return encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, OTS_TUPLE], [
    role,
    sessionId,
    { leafIndex: ots.leafIndex, sig: ots.sig, path: ots.path },
  ]);
}

/** Same length as a real signature (so preVerificationGas is right) but fails WOTS verification. */
export function dummyAccountSignature(role: number, sessionId: Hex, height: number, leafIndex: number): Hex {
  const zero = pad("0x01", { size: 32 });
  return encodeAccountSignature(role, sessionId, {
    leafIndex,
    sig: `0x${"11".repeat(67 * 32)}`,
    path: Array(height).fill(zero),
  });
}

export function userOpHash(op: UserOp, chainId: number): Hex {
  return getUserOperationHash({
    chainId,
    entryPointAddress: ENTRY_POINT_V07,
    entryPointVersion: "0.7",
    userOperation: { ...op, signature: "0x" },
  });
}

/** JSON-RPC form: bigint → hex quantity; omits unset optional fields. */
export function toRpcUserOp(op: UserOp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(op)) {
    if (v === undefined) continue;
    out[k] = typeof v === "bigint" ? toHex(v) : (v as string);
  }
  return out;
}

export function fromRpcUserOp(o: Record<string, string>): UserOp {
  const big = (x?: string) => (x === undefined ? undefined : BigInt(x));
  return {
    sender: o.sender as Address,
    nonce: BigInt(o.nonce),
    factory: o.factory as Address | undefined,
    factoryData: o.factoryData as Hex | undefined,
    callData: o.callData as Hex,
    callGasLimit: BigInt(o.callGasLimit),
    verificationGasLimit: BigInt(o.verificationGasLimit),
    preVerificationGas: BigInt(o.preVerificationGas),
    maxFeePerGas: BigInt(o.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(o.maxPriorityFeePerGas),
    paymaster: o.paymaster as Address | undefined,
    paymasterVerificationGasLimit: big(o.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit: big(o.paymasterPostOpGasLimit),
    paymasterData: o.paymasterData as Hex | undefined,
    signature: o.signature as Hex,
  };
}

// ── call data builders ──

export const accountCalls = {
  openSession: (key: KeyCommitment, maxPerPayment: bigint, budget: bigint, expiresAt: bigint, payees: Address[]) =>
    encodeFunctionData({
      abi: hashgateAccountAbi,
      functionName: "openSession",
      args: [key, maxPerPayment, budget, Number(expiresAt), payees],
    }),
  revokeSession: (sessionId: Hex) => encodeFunctionData({ abi: hashgateAccountAbi, functionName: "revokeSession", args: [sessionId] }),
  agentPay: (sessionId: Hex, to: Address, amount: bigint, memo: Hex) =>
    encodeFunctionData({ abi: hashgateAccountAbi, functionName: "agentPay", args: [sessionId, to, amount, memo] }),
  withdraw: (token: Address, to: Address, amount: bigint) =>
    encodeFunctionData({
      abi: hashgateAccountAbi,
      functionName: "execute",
      args: [token, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] })],
    }),
  rotateOwnerKey: (key: KeyCommitment) => encodeFunctionData({ abi: hashgateAccountAbi, functionName: "rotateOwnerKey", args: [key] }),
};

/** sessionId = keccak256(abi.encode(account, pubSeed, root, height)), as HashgateAccount.sessionIdOf. */
export function accountSessionIdOf(account: Address, key: KeyCommitment): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }], [
      account,
      key.pubSeed,
      key.root,
      key.height,
    ]),
  );
}

/** EntryPoint / bundler error codes in plain language. */
export const AA_ERRORS: Record<string, string> = {
  AA21: "The account has no gas deposit and no paymaster.",
  AA23: "The account refused the operation during validation.",
  AA24: "Signature check failed: the post-quantum signature does not match the account's key.",
  AA25: "Invalid nonce: this operation was already used (replay).",
  AA22: "The operation has expired or isn't valid yet (session expiry is enforced as validUntil).",
  AA31: "The paymaster's gas deposit is too low.",
  AA33: "The paymaster refused to sponsor this operation.",
  AA51: "Prefund below the actual gas cost.",
};
