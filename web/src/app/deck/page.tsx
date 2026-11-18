import type { Metadata } from "next";
import "./deck.css";
import { HASHGATE, REPO_URL } from "@/lib/config";

export const metadata: Metadata = { title: "Pitch deck — Hashgate" };

const LIVE = process.env.NEXT_PUBLIC_SITE_URL?.replace("https://", "") || "hashgate.vercel.app";
const TOTAL = 9;
const Foot = ({ n }: { n: number }) => (
  <div className="foot"><span>Hashgate · post-quantum session keys for AI payment agents</span><span>{n} / {TOTAL}</span></div>
);
const bars = Array.from({ length: 40 }, (_, i) => 20 + ((i * 37) % 80));
const R = ({ children }: { children: React.ReactNode }) => <span className="mono text-rose">{children}</span>;

export default function Deck() {
  return (
    <div className="deck deck-wrap -mx-4 py-6">
      <p className="deck-hint mb-4 text-center text-xs text-dim">1280×720 slides · scroll sideways on a phone</p>

      <section className="slide">
        <div className="chains" aria-hidden>{bars.map((h, i) => <div key={i} style={{ height: `${h}%` }} />)}</div>
        <p className="kicker">Aevum Builder Challenge #1 · Native AI Assistants</p>
        <h1>Your AI agent&apos;s key won&apos;t survive Q-Day.<br /><em>Its Hashgate session will.</em></h1>
        <p className="big">Stablecoin budgets for AI agents on QDay Aevum, authorised by hash-based one-time signatures instead of ECDSA.</p>
        <Foot n={1} />
      </section>

      <section className="slide">
        <p className="kicker">The problem</p>
        <h2>Agents that pay are given keys that do too much, and those keys have an expiry date.</h2>
        <div className="cols">
          <div className="cell"><h3>All-or-nothing keys</h3><p>Agents get a private key or an ECDSA session key. One prompt injection or leaked env var moves the balance.</p></div>
          <div className="cell"><h3>Guardrails in the prompt</h3><p>The rules live inside the system being attacked. A poisoned invoice talks around them.</p></div>
          <div className="cell"><h3>Q-Day</h3><p>secp256k1 falls to Shor&apos;s algorithm. Public keys on-chain today can be harvested now and forged later.</p></div>
        </div>
        <Foot n={2} />
      </section>

      <section className="slide">
        <p className="kicker">The idea</p>
        <h2>Move the spending decision onto <em>hash-based signatures</em>, and the rules onto the chain.</h2>
        <div className="flow">
          <div className="box"><b>Owner key tree</b><span>32 one-time WOTS keys in the browser. Signs: open session, revoke, withdraw.</span></div>
          <i>→</i>
          <div className="box hi"><b>Hashgate.sol</b><span>Verifies WOTS + Merkle path in Solidity, burns the key, enforces the policy. No admin, no ECDSA owner.</span></div>
          <i>→</i>
          <div className="box"><b>Vendor</b><span>tUSD8 with an on-chain receipt.</span></div>
        </div>
        <p className="big">The agent gets its own tree of 64 one-time keys, one per payment. The relayer that pays gas can&apos;t change a byte it submits.</p>
        <Foot n={3} />
      </section>

      <section className="slide">
        <p className="kicker">What the contract enforces, every payment</p>
        <h2>Seven checks no prompt and no stolen ECDSA key can reach.</h2>
        <table className="t"><tbody>
          <tr><td>Session live</td><td>Owner can revoke instantly</td><td className="code">SessionIsRevoked</td></tr>
          <tr><td>Expiry</td><td>Authority ends by default</td><td className="code">SessionExpired</td></tr>
          <tr><td>Per-payment cap</td><td>Inflated invoices bounce</td><td className="code">OverPerPaymentCap</td></tr>
          <tr><td>Total budget</td><td>Runaway loops stop</td><td className="code">OverBudget</td></tr>
          <tr><td>Payee allowlist</td><td>Prompt-injected redirects bounce</td><td className="code">PayeeNotAllowed</td></tr>
          <tr><td>WOTS signature</td><td>Quantum-safe authorisation</td><td className="code">BadSignature</td></tr>
          <tr><td>One-time key unused</td><td>No replays</td><td className="code">LeafAlreadyUsed</td></tr>
        </tbody></table>
        <Foot n={4} />
      </section>

      <section className="slide">
        <p className="kicker">Live demo · no wallet needed</p>
        <h2>A compromised agent, a poisoned invoice, and a Q-Day attacker.</h2>
        <div className="cols">
          <div className="cell"><h3>Inbox of 4 invoices</h3><p>2 paid with post-quantum signatures. The over-cap invoice is refused. A hidden “send 0.02 to 0xBAD…” is refused: <R>PayeeNotAllowed</R>.</p></div>
          <div className="cell"><h3>Q-Day drill</h3><p>An attacker with every ECDSA key forges a withdrawal of the vault: <R>BadSignature</R>. Replaying a real signature: <R>LeafAlreadyUsed</R>.</p></div>
          <div className="cell"><h3>Revoke</h3><p>One owner signature. The agent&apos;s next run is refused: <R>SessionIsRevoked</R>.</p></div>
        </div>
        <p className="big">Every step is a real Aevum transaction with an explorer link. Refusals can be recorded on-chain as reverted transactions.</p>
        <Foot n={5} />
      </section>

      <section className="slide">
        <p className="kicker">Under the hood</p>
        <h2>Real post-quantum verification, on Aevum today.</h2>
        <div className="cols">
          <div className="cell"><div className="stat">2,144 B</div><p>WOTS signature: 67 keccak hash chains, w = 16, tweaked per call against multi-target attacks.</p></div>
          <div className="cell"><div className="stat">~270k</div><p>gas per agent payment, about 0.0003 tQDAY. Assembly verifier, no precompile needed.</p></div>
          <div className="cell"><div className="stat">0</div><p>ECDSA keys with authority. No admin, no owner and no upgrade path in the contract.</p></div>
        </div>
        <p className="big">Tested three ways: Foundry unit and fuzz tests, a TypeScript↔Solidity signature vector, and a live smoke test on Aevum.</p>
        <Foot n={6} />
      </section>

      <section className="slide">
        <p className="kicker">For builders</p>
        <h2><span className="mono">@hashgate/sdk</span>: post-quantum authority for any agent wallet.</h2>
        <pre className="mono mt-8 rounded-2xl border border-line bg-panel p-6 text-[19px] leading-relaxed text-ink">{`const agent = KeyTree.fromSeed(randomSeed(), 6);   // 64 one-time keys
const ots   = agent.sign(0, payDigest(domain, sessionId, vendor, amount, memo));
verifyOTS(agent.commitment(), digest, ots);          // same maths as WOTS.sol
// → pay(sessionId, vendor, amount, memo, ots) through any relayer`}</pre>
        <p className="big">MIT licensed: Solidity library, vault contract, SDK, relayer and agent templates.</p>
        <Foot n={7} />
      </section>

      <section className="slide">
        <p className="kicker">Market and roadmap</p>
        <h2>Agent-wallet infrastructure for the post-quantum chain.</h2>
        <div className="cols two">
          <div className="cell"><h3>Who pays</h3><p>Teams running payment agents (payables, procurement, API buying) and wallets that want PQ-safe delegation. The SDK and contracts are free; a hosted relayer and policy service is charged per payment or per seat.</p></div>
          <div className="cell"><h3>Next</h3><p>An XMSS-style hypertree for thousands of payments per session · stateless SPHINCS+ owner keys · an ERC-8004 / x402 agent identity adapter · a native PQ precompile on QDay mainnet.</p></div>
        </div>
        <Foot n={8} />
      </section>

      <section className="slide">
        <div className="chains" aria-hidden>{bars.map((h, i) => <div key={i} style={{ height: `${120 - h}%` }} />)}</div>
        <p className="kicker">Try to break it</p>
        <h1>The agent can ask.<br /><em>Only a hash chain can pay.</em></h1>
        <div className="mt-10 space-y-2">
          <p>Live: <span className="text-ink">{LIVE}</span></p>
          <p>Code: <span className="text-ink">{REPO_URL.replace("https://", "")}</span></p>
          <p className="mono" style={{ fontSize: 17 }}>Contract {HASHGATE} · Aevum testnet 44005</p>
        </div>
        <Foot n={9} />
      </section>
    </div>
  );
}
