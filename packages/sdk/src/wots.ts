// WOTS (Winternitz one-time signatures) over keccak256, n = 32 bytes, w = 16.
// Byte-for-byte compatible with contracts/src/WOTS.sol.
import { keccak_256 } from "@noble/hashes/sha3";

export const CHAINS = 67;
export const W_MAX = 15;
export const SIG_BYTES = CHAINS * 32;

export type Bytes = Uint8Array;

/** Writes `value` as a 32-byte big-endian word into `buf` at `offset`. */
function writeWord(buf: Bytes, offset: number, value: bigint) {
  for (let i = 31; i >= 0; i--) {
    buf[offset + i] = Number(value & 0xffn);
    value >>= 8n;
  }
}

export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function keccak(data: Bytes): Bytes {
  return keccak_256(data);
}

/** 67 base-16 digits: 64 from the digest (most significant nibble first) + 3 checksum digits. */
export function digits(digest: Bytes): number[] {
  if (digest.length !== 32) throw new Error("digest must be 32 bytes");
  const d: number[] = [];
  let csum = 0;
  for (let i = 0; i < 32; i++) {
    const hi = digest[i] >> 4;
    const lo = digest[i] & 15;
    d.push(hi, lo);
    csum += W_MAX - hi + (W_MAX - lo);
  }
  d.push((csum >> 8) & 15, (csum >> 4) & 15, csum & 15);
  return d;
}

/** Hash-chain state with a reusable 96-byte buffer: pubSeed ‖ tweak ‖ x. */
class Chainer {
  private buf = new Uint8Array(96);
  constructor(pubSeed: Bytes) {
    this.buf.set(pubSeed, 0);
  }
  /** Applies chain steps [from, to) to x. */
  run(x: Bytes, leaf: number, chain: number, from: number, to: number): Bytes {
    let cur = x;
    const base = (BigInt(leaf) << 16n) | (BigInt(chain) << 8n);
    for (let j = from; j < to; j++) {
      writeWord(this.buf, 32, base | BigInt(j));
      this.buf.set(cur, 64);
      cur = keccak_256(this.buf);
    }
    return cur;
  }
}

/** Secret chain start for (leaf, chain), derived from the secret seed. */
function secretStart(skSeed: Bytes, leaf: number, chain: number): Bytes {
  const buf = new Uint8Array(64);
  buf.set(skSeed, 0);
  writeWord(buf, 32, (BigInt(leaf) << 16n) | (BigInt(chain) << 8n));
  return keccak_256(buf);
}

function leafHash(pubSeed: Bytes, leaf: number, pks: Bytes[]): Bytes {
  const buf = new Uint8Array(64 + CHAINS * 32);
  buf.set(pubSeed, 0);
  writeWord(buf, 32, (1n << 255n) | BigInt(leaf));
  pks.forEach((pk, i) => buf.set(pk, 64 + i * 32));
  return keccak_256(buf);
}

/** Public leaf (compressed one-time public key) for one leaf index. */
export function wotsLeaf(skSeed: Bytes, pubSeed: Bytes, leaf: number): Bytes {
  const c = new Chainer(pubSeed);
  const pks: Bytes[] = [];
  for (let i = 0; i < CHAINS; i++) pks.push(c.run(secretStart(skSeed, leaf, i), leaf, i, 0, W_MAX));
  return leafHash(pubSeed, leaf, pks);
}

/** One-time signature of `digest` with leaf `leaf`. Never sign two different digests with one leaf. */
export function wotsSign(skSeed: Bytes, pubSeed: Bytes, leaf: number, digest: Bytes): Bytes {
  const c = new Chainer(pubSeed);
  const d = digits(digest);
  const sig = new Uint8Array(SIG_BYTES);
  for (let i = 0; i < CHAINS; i++) sig.set(c.run(secretStart(skSeed, leaf, i), leaf, i, 0, d[i]), i * 32);
  return sig;
}

/** Recomputes the leaf from a signature, exactly like WOTS.leafFromSignature in Solidity. */
export function wotsLeafFromSignature(pubSeed: Bytes, leaf: number, digest: Bytes, sig: Bytes): Bytes {
  if (sig.length !== SIG_BYTES) throw new Error("bad signature length");
  const c = new Chainer(pubSeed);
  const d = digits(digest);
  const pks: Bytes[] = [];
  for (let i = 0; i < CHAINS; i++) pks.push(c.run(sig.slice(i * 32, i * 32 + 32), leaf, i, d[i], W_MAX));
  return leafHash(pubSeed, leaf, pks);
}
