"use client";
// Browser-side Hashgate client: keys live in this browser, signatures are made here, and the
// relayer only ever sees finished calldata.
import { createPublicClient, encodeFunctionData, http, parseUnits, keccak256, toHex, type Address, type Hex } from "viem";
import {
  KeyTree, aevum, domainOf, hashgateAbi, openSessionDigest, payDigest, randomSeed, revokeDigest, sessionIdOf,
  vaultIdOf, withdrawDigest, type KeyCommitment, type Policy,
} from "@hashgate/sdk";
import { CHAIN_ID, HASHGATE } from "./config";

export const pub = createPublicClient({ chain: aevum, transport: http(undefined, { retryCount: 3 }) });
export const DOMAIN = domainOf(CHAIN_ID, HASHGATE);

export const OWNER_HEIGHT = 5; // 32 owner operations, then rotate
export const AGENT_HEIGHT = 6; // 64 agent payments per session

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
  vaultId: Hex;
  salt: Hex;
  ownerSeed: Hex;
  ownerHeight: number;
  ownerLeaves: Hex[];
  nextOwnerLeaf: number;
  createdTx?: Hex;
  createdAt: number;
  sessions: StoredSession[];
};
type Store = { v: 1; vaults: StoredVault[]; active?: Hex };

const KEY = "hashgate.v1";

export function loadStore(): Store {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s?.v === 1) return s;
  } catch {}
  return { v: 1, vaults: [] };
}
export function saveStore(s: Store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}
export function activeVault(s: Store): StoredVault | undefined {
  return s.vaults.find((v) => v.vaultId === s.active) ?? s.vaults[0];
}

export type RelayResult = {
  ok: boolean;
  stage?: "simulation" | "mined" | "send";
  fn?: string;
  hash?: Hex;
  block?: string;
  gasUsed?: string;
  error?: string;
  message?: string;
  args?: unknown[];
};

export async function relay(data: Hex, simulateOnly = false, force = false): Promise<RelayResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data, simulateOnly, force }),
      });
      const body = (await res.json()) as RelayResult;
      if (res.status >= 500 && attempt === 0) continue; // one retry on RPC hiccups
      return body;
    } catch {
      if (attempt === 1) return { ok: false, error: "Network", message: "Could not reach the relayer. Check your connection and try again." };
    }
  }
  return { ok: false, error: "Network", message: "Could not reach the relayer." };
}

export const usd = (x: string | number) => parseUnits(String(x), 6);

/** Picks the next owner leaf that is unused both locally and on-chain, and reserves it forever. */
async function takeLeaf(key: KeyCommitment, next: number, size: number): Promise<number> {
  for (let i = next; i < size; i++) {
    const used = await pub.readContract({ address: HASHGATE, abi: hashgateAbi, functionName: "isLeafUsed", args: [key, i] });
    if (!used) return i;
  }
  throw new Error("This key has no one-time leaves left. Rotate to a fresh key.");
}

export function ownerTree(v: StoredVault) {
  return KeyTree.fromCache(v.ownerSeed, v.ownerHeight, v.ownerLeaves);
}
export function sessionTree(s: StoredSession) {
  return KeyTree.fromCache(s.seed, s.height, s.leaves);
}

// ── vault lifecycle ──

export function newVaultKeys(): StoredVault {
  const ownerSeed = randomSeed();
  const tree = KeyTree.fromSeed(ownerSeed, OWNER_HEIGHT);
  const salt = randomSeed();
  return {
    vaultId: vaultIdOf(tree.commitment(), salt), salt, ownerSeed, ownerHeight: OWNER_HEIGHT,
    ownerLeaves: tree.leafCache(), nextOwnerLeaf: 0, createdAt: Date.now(), sessions: [],
  };
}

export function createVaultData(v: StoredVault): Hex {
  return encodeFunctionData({ abi: hashgateAbi, functionName: "createVault", args: [ownerTree(v).commitment(), v.salt] });
}

/** Owner-signed call. `reserve` is called with the leaf before the signature leaves the browser. */
async function ownerSign(v: StoredVault, digest: (owner: KeyCommitment) => Hex, reserve: (leaf: number) => void) {
  const tree = ownerTree(v);
  const key = tree.commitment();
  const leaf = await takeLeaf(key, v.nextOwnerLeaf, tree.size);
  reserve(leaf + 1); // a leaf whose signature left this device is never signed again
  return tree.sign(leaf, digest(key));
}

export type PolicyInput = { maxPerPayment: string; budget: string; hours: number; payees: Address[] };

export async function openSessionCall(v: StoredVault, label: string, p: PolicyInput, reserve: (leaf: number) => void) {
  const seed = randomSeed();
  const tree = KeyTree.fromSeed(seed, AGENT_HEIGHT);
  const key = tree.commitment();
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + Math.round(p.hours * 3600));
  const policy: Policy = { maxPerPayment: usd(p.maxPerPayment), budget: usd(p.budget), expiresAt, payees: p.payees };
  const ots = await ownerSign(v, () => openSessionDigest(DOMAIN, v.vaultId, key, policy), reserve);
  const session: StoredSession = {
    sessionId: sessionIdOf(v.vaultId, key), label, seed, height: AGENT_HEIGHT, leaves: tree.leafCache(), nextLeaf: 0,
    policy: { maxPerPayment: policy.maxPerPayment.toString(), budget: policy.budget.toString(), expiresAt: expiresAt.toString(), payees: p.payees },
  };
  const data = encodeFunctionData({ abi: hashgateAbi, functionName: "openSession", args: [v.vaultId, key, policy, ots] });
  return { session, data, ots };
}

export async function revokeCall(v: StoredVault, s: StoredSession, reserve: (leaf: number) => void) {
  const ots = await ownerSign(v, () => revokeDigest(DOMAIN, s.sessionId), reserve);
  return encodeFunctionData({ abi: hashgateAbi, functionName: "revokeSession", args: [s.sessionId, ots] });
}

export async function withdrawCall(v: StoredVault, to: Address, amount: bigint, reserve: (leaf: number) => void) {
  const ots = await ownerSign(v, (k) => withdrawDigest(DOMAIN, v.vaultId, to, amount, k.root), reserve);
  return encodeFunctionData({ abi: hashgateAbi, functionName: "withdraw", args: [v.vaultId, to, amount, ots] });
}

// ── agent ──

export const memoOf = (s: string) => keccak256(toHex(s.slice(0, 64)));

export function agentPayCall(s: StoredSession, to: Address, amount: bigint, memoText: string) {
  const tree = sessionTree(s);
  const leaf = s.nextLeaf;
  if (leaf >= tree.size) throw new Error("This session has used all of its one-time keys. Open a new session.");
  const ots = tree.sign(leaf, payDigest(DOMAIN, s.sessionId, to, amount, memoOf(memoText)));
  const data = encodeFunctionData({ abi: hashgateAbi, functionName: "pay", args: [s.sessionId, to, amount, memoOf(memoText), ots] });
  return { data, leaf, sigBytes: (ots.sig.length - 2) / 2 };
}

export async function checkPayment(sessionId: Hex, to: Address, amount: bigint): Promise<number> {
  return Number(await pub.readContract({ address: HASHGATE, abi: hashgateAbi, functionName: "checkPayment", args: [sessionId, to, amount] }));
}

export async function readVault(vaultId: Hex) {
  const [owner, balance, sessions, exists, ownerLeavesUsed] = await pub.readContract({
    address: HASHGATE, abi: hashgateAbi, functionName: "getVault", args: [vaultId],
  });
  return { owner, balance, sessions, exists, ownerLeavesUsed };
}

export async function readSession(sessionId: Hex) {
  const [s, used] = await pub.readContract({ address: HASHGATE, abi: hashgateAbi, functionName: "getSession", args: [sessionId] });
  return { ...s, leavesUsed: used };
}
