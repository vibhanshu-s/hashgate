// The exact digests Hashgate.sol asks WOTS keys to sign. Keep in sync with the contract.
import { concat, encodeAbiParameters, keccak256, pad, toBytes, type Address, type Hex } from "viem";
import type { KeyCommitment } from "./tree.js";

export const OP = {
  openSession: keccak256(toBytes("hashgate.openSession")),
  revokeSession: keccak256(toBytes("hashgate.revokeSession")),
  withdraw: keccak256(toBytes("hashgate.withdraw")),
  rotateOwner: keccak256(toBytes("hashgate.rotateOwner")),
  pay: keccak256(toBytes("hashgate.pay")),
} as const;

export type Policy = { maxPerPayment: bigint; budget: bigint; expiresAt: bigint; payees: Address[] };

export function domainOf(chainId: number | bigint, contract: Address): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }], [
      "Hashgate v1",
      BigInt(chainId),
      contract,
    ]),
  );
}

export function vaultIdOf(owner: KeyCommitment, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }], [
      owner.pubSeed,
      owner.root,
      owner.height,
      salt,
    ]),
  );
}

export function sessionIdOf(vaultId: Hex, key: KeyCommitment): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }], [
      vaultId,
      key.pubSeed,
      key.root,
      key.height,
    ]),
  );
}

/** keccak256(abi.encodePacked(address[])) — each address left-padded to 32 bytes. */
export function payeesHash(payees: Address[]): Hex {
  return keccak256(payees.length ? concat(payees.map((p) => pad(p, { size: 32 }))) : "0x");
}

export function openSessionDigest(domain: Hex, vaultId: Hex, key: KeyCommitment, p: Policy): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
        { type: "uint8" }, { type: "uint128" }, { type: "uint128" }, { type: "uint64" }, { type: "bytes32" },
      ],
      [domain, OP.openSession, vaultId, key.pubSeed, key.root, key.height, p.maxPerPayment, p.budget, p.expiresAt, payeesHash(p.payees)],
    ),
  );
}

export function revokeDigest(domain: Hex, sessionId: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], [domain, OP.revokeSession, sessionId]));
}

/** `ownerRoot` is the vault's current owner root (binds the withdrawal to the key that signs it). */
export function withdrawDigest(domain: Hex, vaultId: Hex, to: Address, amount: bigint, ownerRoot: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
      [domain, OP.withdraw, vaultId, to, amount, ownerRoot],
    ),
  );
}

export function rotateDigest(domain: Hex, vaultId: Hex, key: KeyCommitment): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }],
      [domain, OP.rotateOwner, vaultId, key.pubSeed, key.root, key.height],
    ),
  );
}

export function payDigest(domain: Hex, sessionId: Hex, to: Address, amount: bigint, memo: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
      [domain, OP.pay, sessionId, to, amount, memo],
    ),
  );
}

export function depositNonce(contract: Address, vaultId: Hex, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }], [contract, vaultId, salt]));
}
