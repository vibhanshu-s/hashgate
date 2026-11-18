// A Merkle tree of WOTS one-time keys ("key tree"), derived from one 32-byte seed.
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { concat, keccak, wotsLeaf, wotsLeafFromSignature, wotsSign, type Bytes } from "./wots.js";

const enc = new TextEncoder();

export type KeyCommitment = { pubSeed: Hex; root: Hex; height: number };

/** One-time signature + auth path, shaped like the contract's `OTS` struct. */
export type OTS = { leafIndex: number; sig: Hex; path: Hex[] };

export function randomSeed(): Hex {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
}

export function hashPair(a: Bytes, b: Bytes): Bytes {
  return keccak(concat(a, b));
}

export class KeyTree {
  readonly height: number;
  readonly size: number;
  readonly pubSeed: Bytes;
  private readonly skSeed: Bytes;
  /** levels[0] = leaves, levels[height] = [root] */
  private readonly levels: Bytes[][];

  private constructor(seed: Bytes, height: number, leaves?: Bytes[]) {
    if (seed.length !== 32) throw new Error("seed must be 32 bytes");
    if (height < 1 || height > 12) throw new Error("height must be 1..12");
    this.height = height;
    this.size = 2 ** height;
    this.pubSeed = keccak(concat(enc.encode("hashgate.pubSeed"), seed));
    this.skSeed = keccak(concat(enc.encode("hashgate.skSeed"), seed));
    const ls = leaves ?? Array.from({ length: this.size }, (_, i) => wotsLeaf(this.skSeed, this.pubSeed, i));
    if (ls.length !== this.size) throw new Error("leaf cache does not match height");
    this.levels = [ls];
    for (let h = 0; h < height; h++) {
      const prev = this.levels[h];
      const next: Bytes[] = [];
      for (let i = 0; i < prev.length; i += 2) next.push(hashPair(prev[i], prev[i + 1]));
      this.levels.push(next);
    }
  }

  /** Derives every one-time key (2**height × 67 hash chains). height 6 ≈ 65k hashes. */
  static fromSeed(seed: Hex, height: number): KeyTree {
    return new KeyTree(hexToBytes(seed), height);
  }

  /** Rebuilds from a cached leaf list (skips the expensive chain derivation). */
  static fromCache(seed: Hex, height: number, leaves: Hex[]): KeyTree {
    return new KeyTree(hexToBytes(seed), height, leaves.map((l) => hexToBytes(l)));
  }

  get root(): Bytes {
    return this.levels[this.height][0];
  }

  commitment(): KeyCommitment {
    return { pubSeed: bytesToHex(this.pubSeed), root: bytesToHex(this.root), height: this.height };
  }

  leafCache(): Hex[] {
    return this.levels[0].map((l) => bytesToHex(l));
  }

  path(leafIndex: number): Hex[] {
    const out: Hex[] = [];
    let idx = leafIndex;
    for (let h = 0; h < this.height; h++) {
      out.push(bytesToHex(this.levels[h][idx ^ 1]));
      idx >>= 1;
    }
    return out;
  }

  /** Signs a 32-byte digest with one-time key `leafIndex`. The caller must never reuse a leaf. */
  sign(leafIndex: number, digest: Hex): OTS {
    if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= this.size) throw new Error("leaf out of range");
    const sig = wotsSign(this.skSeed, this.pubSeed, leafIndex, hexToBytes(digest));
    return { leafIndex, sig: bytesToHex(sig), path: this.path(leafIndex) };
  }
}

/** Off-chain verification, identical to WOTS.verify in Solidity. */
export function verifyOTS(key: KeyCommitment, digest: Hex, ots: OTS): boolean {
  if (ots.path.length !== key.height || ots.leafIndex >> key.height !== 0) return false;
  let node = wotsLeafFromSignature(hexToBytes(key.pubSeed), ots.leafIndex, hexToBytes(digest), hexToBytes(ots.sig));
  let idx = ots.leafIndex;
  for (const sib of ots.path) {
    const s = hexToBytes(sib);
    node = idx & 1 ? hashPair(s, node) : hashPair(node, s);
    idx >>= 1;
  }
  return bytesToHex(node) === key.root.toLowerCase();
}
