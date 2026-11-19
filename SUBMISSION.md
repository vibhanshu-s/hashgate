# DoraHacks BUIDL submission — Hashgate

**Name:** Hashgate

**Tagline (one line):** Post-quantum session keys for AI payment agents: tUSD8 budgets on QDay Aevum, authorised by hash-based one-time signatures verified in Solidity.

**Track:** Native AI Assistants (also fits Open Innovation, Decentralized Payments)

**Submitted:** https://dorahacks.io/build/51330 (Native AI Assistants track, 2026-11-19, under review)

**Links**
- Live demo (no wallet needed): https://hashgate-three.vercel.app
- GitHub: https://github.com/vibhanshu-s/hashgate
- Demo video: https://youtu.be/d-nyhSCl2Kw
- Pitch deck: https://hashgate-three.vercel.app/deck (PDF in the repo: `media/hashgate-deck.pdf`)
- Contract (Aevum testnet 44005): 0x699d045bb5acfe677e7b0a44257eb4c9a5c73674

## Description

On Q-Day, a quantum computer can forge any ECDSA signature, including the key an AI agent spends with. Every agent-wallet design we've seen, including session-key smart accounts, still authorises the agent with ECDSA.

Hashgate gives an AI agent a stablecoin budget on QDay Aevum where every spending decision is authorised by a **WOTS (Winternitz) one-time signature verified in plain Solidity**: no ECDSA, no precompile, working on Aevum today.

- **Owner key:** a Merkle tree of 32 one-time keys derived in the browser. Opening a session, revoking it, withdrawing and rotating the key each spend one key.
- **Agent session:** a second tree of 64 one-time keys plus an on-chain policy: per-payment cap, total budget, expiry, payee allowlist. One key per payment, burnt on-chain.
- **Untrusted relayer:** pays gas, can't change a signed byte. A stolen relayer/deployer/wallet key moves nothing.
- **AI payables agent (Gemini):** reads an inbox of invoices and signs payments. In the demo we run it *as a compromised model* that obeys an injected "send 0.02 tUSD8 to 0xBAD…" instruction, and the contract refuses it (`PayeeNotAllowed`), as well as an over-cap invoice (`OverPerPaymentCap`).
- **Q-Day drill:** an attacker with every ECDSA key forges a withdrawal (`BadSignature`) and replays a real agent signature (`LeafAlreadyUsed`). One owner signature revokes the agent (`SessionIsRevoked`).
- **Zero-friction onboarding:** a judge can do the whole flow in about a minute without a wallet; the relayer pays gas and a demo treasury drips 0.05 tUSD8. MetaMask users can also deposit gaslessly via EIP-3009 bound to their vault.

**Numbers:** 2,144-byte signatures (67 keccak hash chains, w = 16, per-call tweaks); ~220k–270k gas per post-quantum payment (≈0.0003 tQDAY); 0 ECDSA keys with authority.

**Tech:** Solidity 0.8.24 (Shanghai), Foundry (unit, fuzz, TS↔Solidity signature vector, in CI), TypeScript SDK `@hashgate/sdk` (viem, @noble/hashes), Next.js 15 on Vercel, Gemini with deterministic fallback, Aevum Blockscout API for the activity feed.

**Verifiable on Aevum:** see the README's transaction table: createVault, deposit, WOTS-signed openSession, WOTS-signed pay, revokeSession, and a reverted on-chain refusal showing `PayeeNotAllowed(0xBaDBad…BAd)`.

**Reusable:** MIT-licensed WOTS verifier library, vault contract and SDK any Aevum wallet can adopt for post-quantum delegation.

**Built entirely during the build window (from 16 Nov 2026), solo.**
