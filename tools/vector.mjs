// Writes contracts/test/fixtures/vector.json: a WOTS signature made by the TypeScript SDK,
// which the Foundry test verifies with the Solidity library (cross-language check).
import { writeFileSync } from "node:fs";
import { keccak256, toHex } from "viem";
import { KeyTree } from "../packages/sdk/dist/index.js";

const seed = keccak256(toHex("hashgate test vector seed"));
const tree = KeyTree.fromSeed(seed, 4);
const digest = keccak256(toHex("hashgate test vector message"));
const ots = tree.sign(11, digest);
const c = tree.commitment();
writeFileSync(new URL("../contracts/test/fixtures/vector.json", import.meta.url),
  JSON.stringify({ pubSeed: c.pubSeed, root: c.root, height: c.height, leafIndex: ots.leafIndex, digest, sig: ots.sig, path: ots.path }, null, 1));
console.log("vector written, root", c.root);
