"use client";
// Browser-side Hashgate client (ERC-4337). Keys live in this browser; every action is a
// UserOperation whose userOpHash is signed here with a WOTS one-time key and sent through the
// QDay bundler. The server only estimates gas and forwards — the browser re-derives the hash.
import { createPublicClient, erc20Abi, getAddress, http, keccak256, parseUnits, toHex, type Address, type Hex } from "viem";
import {
  KeyTree, ROLE_OWNER, ROLE_SESSION, TUSD8, accountCalls, accountSessionIdOf, aevum, encodeAccountSignature,
  fromRpcUserOp, hashgateAccountAbi, hashgateAccountFactoryAbi, randomSeed, toRpcUserOp, userOpHash,
  type KeyCommitment,
} from "@hashgate/sdk";
import { ACCOUNT_FACTORY, CHAIN_ID } from "./config";

export const pub = createPublicClient({ chain: aevum, transport: http(undefined, { retryCount: 3 }) });

export const OWNER_HEIGHT = 5; // 32 owner operations, then rotate
export const AGENT_HEIGHT = 6; // 64 agent payments per session
const ZERO32 = `0x${"00".repeat(32)}` as Hex;

export type StoredSession = {
  sessionId: Hex;
  label: string;
  seed: Hex;
  height: number;
  leaves: Hex[];
  nextLeaf: number;
  policy: { maxPerPayment: string; budget: string; expiresAt: string; payees: Address[] };
  openedTx?: Hex;
  revoked?: boolean;
};
export type StoredVault = {
  account: Address;
  salt: Hex;
  ownerSeed: Hex;
  ownerHeight: number;
  ownerLeaves: Hex[];
  nextOwnerLeaf: number;
  createdTx?: Hex;
  createdAt: number;
  sessions: StoredSession[];
};
export type Store = { v: 2; vaults: StoredVault[]; active?: Address };

const KEY = "hashgate.v2";

export function loadStore(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s?.v === 2) return s;
  } catch {}
  return { v: 2, vaults: [] };
}
export function saveStore(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}
export function activeVault(s: Store): StoredVault | undefined {
  return s.vaults.find((v) => v.account === s.active) ?? s.vaults[0];
}

export const usd = (x: string | number) => parseUnits(String(x), 6);
export const memoOf = (s: string) => keccak256(toHex(s.slice(0, 64)));

export function ownerTree(v: StoredVault) {
  return KeyTree.fromCache(v.ownerSeed, v.ownerHeight, v.ownerLeaves);
}
export function sessionTree(s: StoredSession) {
  return KeyTree.fromCache(s.seed, s.height, s.leaves);
}

// ── API plumbing ──

export type OpResult = {
  ok: boolean;
  stage?: string;
  via?: string;
  hash?: Hex;
  userOpHash?: Hex;
  gasUsed?: string;
  error?: string;
  code?: string;
  message?: string;
  leaf?: number;
};

async function post<T>(path: string, body: unknown): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json()) as T;
      if (res.status >= 500 && attempt === 0) continue;
      return j;
    } catch {
      if (attempt === 1) return { ok: false, error: "Network", message: "Could not reach the server. Check your connection and try again." } as T;
    }
  }
  return { ok: false, error: "Network", message: "Could not reach the server." } as T;
}

/**
 * The whole post-quantum UserOperation flow:
 * prepare (server: nonce, fees, paymaster, bundler gas estimate) → verify the op is ours and
 * recompute userOpHash locally → reserve the leaf → WOTS-sign → send (QDay bundler).
 * `prepared` lets the caller stop before sending (e.g. the record-a-refusal drill).
 */
export async function runOp(args: {
  sender: Address;
  callData: Hex;
  role: number;
  sessionId?: Hex;
  tree: KeyTree;
  leaf: number;
  reserve: (nextLeaf: number) => void;
  force?: boolean;
}): Promise<OpResult & { signedOp?: Record<string, string> }> {
  const sessionId = args.sessionId ?? ZERO32;
  const prep = await post<{ ok: boolean; op?: Record<string, string>; userOpHash?: Hex; error?: string; code?: string; message?: string; stage?: string }>(
    "/api/aa/prepare",
    { sender: args.sender, callData: args.callData, role: args.role, sessionId, height: args.tree.height, leaf: args.leaf, force: args.force },
  );
  if (!prep.ok || !prep.op) return { ok: false, stage: prep.stage ?? "prepare", error: prep.error, code: prep.code, message: prep.message };

  const op = fromRpcUserOp(prep.op);
  if (getAddress(op.sender) !== getAddress(args.sender) || op.callData.toLowerCase() !== args.callData.toLowerCase()) {
    return { ok: false, error: "Tampered", message: "The server returned a different operation than requested. Not signing." };
  }
  const hash = userOpHash(op, CHAIN_ID); // never trust the server's hash
  args.reserve(args.leaf + 1); // a leaf whose signature leaves this device is never signed again
  const ots = args.tree.sign(args.leaf, hash);
  op.signature = encodeAccountSignature(args.role, sessionId, ots);
  const signedOp = toRpcUserOp(op);
  const sent = await post<OpResult>("/api/aa/send", { op: signedOp, force: args.force });
  return { ...sent, leaf: args.leaf, signedOp };
}

/** Re-sends an already signed op (replay drill). */
export function resend(op: Record<string, string>) {
  return post<OpResult>("/api/aa/send", { op });
}

/** Picks the next leaf unused both locally and on-chain. */
async function nextLeaf(account: Address, key: KeyCommitment, from: number, size: number): Promise<number> {
  for (let i = from; i < size; i++) {
    const used = await pub.readContract({ address: account, abi: hashgateAccountAbi, functionName: "isLeafUsed", args: [key, i] });
    if (!used) return i;
  }
  throw new Error("This key has no one-time leaves left. Rotate to a fresh key.");
}

// ── account lifecycle ──

export async function newVaultKeys(): Promise<StoredVault> {
  const ownerSeed = randomSeed();
  const tree = KeyTree.fromSeed(ownerSeed, OWNER_HEIGHT);
  const salt = randomSeed();
  const account = getAddress(
    await pub.readContract({ address: ACCOUNT_FACTORY, abi: hashgateAccountFactoryAbi, functionName: "getAddress", args: [tree.commitment(), salt] }),
  );
  return { account, salt, ownerSeed, ownerHeight: OWNER_HEIGHT, ownerLeaves: tree.leafCache(), nextOwnerLeaf: 0, createdAt: Date.now(), sessions: [] };
}

export function createAccount(v: StoredVault) {
  return post<{ ok: boolean; account?: Address; hash?: Hex; drip?: { hash?: Hex; message?: string }; amount?: string; message?: string }>(
    "/api/aa/create",
    { key: ownerTree(v).commitment(), salt: v.salt },
  );
}

async function ownerOp(v: StoredVault, callData: Hex, reserve: (n: number) => void, force = false) {
  const tree = ownerTree(v);
  const leaf = await nextLeaf(v.account, tree.commitment(), v.nextOwnerLeaf, tree.size);
  return runOp({ sender: v.account, callData, role: ROLE_OWNER, tree, leaf, reserve, force });
}

export type PolicyInput = { maxPerPayment: string; budget: string; hours: number; payees: Address[] };

export async function openSession(v: StoredVault, label: string, p: PolicyInput, reserve: (n: number) => void) {
  const seed = randomSeed();
  const tree = KeyTree.fromSeed(seed, AGENT_HEIGHT);
  const key = tree.commitment();
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + Math.round(p.hours * 3600));
  const callData = accountCalls.openSession(key, usd(p.maxPerPayment), usd(p.budget), expiresAt, p.payees);
  const session: StoredSession = {
    sessionId: accountSessionIdOf(v.account, key), label, seed, height: AGENT_HEIGHT, leaves: tree.leafCache(), nextLeaf: 0,
    policy: { maxPerPayment: usd(p.maxPerPayment).toString(), budget: usd(p.budget).toString(), expiresAt: expiresAt.toString(), payees: p.payees },
  };
  const r = await ownerOp(v, callData, reserve);
  return { session, r };
}

export function revokeSession(v: StoredVault, s: StoredSession, reserve: (n: number) => void) {
  return ownerOp(v, accountCalls.revokeSession(s.sessionId), reserve);
}

export function withdraw(v: StoredVault, to: Address, amount: bigint, reserve: (n: number) => void) {
  return ownerOp(v, accountCalls.withdraw(TUSD8, to, amount), reserve);
}

/** Q-Day drill: an attacker with their own WOTS key (and every ECDSA key) tries to drain the account. */
export async function forgedWithdraw(v: StoredVault, to: Address, amount: bigint) {
  const attacker = KeyTree.fromSeed(randomSeed(), v.ownerHeight);
  const leaf = attacker.size - 1;
  return runOp({ sender: v.account, callData: accountCalls.withdraw(TUSD8, to, amount), role: ROLE_OWNER, tree: attacker, leaf, reserve: () => {} });
}

// ── agent ──

export function agentPay(s: StoredSession, account: Address, to: Address, amount: bigint, memoText: string, reserve: (n: number) => void, force = false) {
  const tree = sessionTree(s);
  if (s.nextLeaf >= tree.size) throw new Error("This session has used all of its one-time keys. Open a new session.");
  return runOp({
    sender: account, callData: accountCalls.agentPay(s.sessionId, to, amount, memoOf(memoText)), role: ROLE_SESSION,
    sessionId: s.sessionId, tree, leaf: s.nextLeaf, reserve, force,
  });
}

export async function checkPayment(account: Address, sessionId: Hex, to: Address, amount: bigint): Promise<number> {
  return Number(await pub.readContract({ address: account, abi: hashgateAccountAbi, functionName: "checkPayment", args: [sessionId, to, amount] }));
}

export async function readVault(account: Address) {
  const code = await pub.getCode({ address: account });
  if (!code || code === "0x") return { exists: false, balance: 0n, ownerLeavesUsed: 0, sessions: 0 };
  const [balance, ownerKey, sessions] = await Promise.all([
    pub.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    pub.readContract({ address: account, abi: hashgateAccountAbi, functionName: "ownerKey" }),
    pub.readContract({ address: account, abi: hashgateAccountAbi, functionName: "sessionCount" }),
  ]);
  return { exists: true, balance, ownerLeavesUsed: ownerKey[1], sessions };
}

export async function readSession(account: Address, sessionId: Hex) {
  const [s, used] = await pub.readContract({ address: account, abi: hashgateAccountAbi, functionName: "getSession", args: [sessionId] });
  return { ...s, leavesUsed: used };
}
