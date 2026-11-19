import Link from "next/link";
import { LiveStats } from "@/components/LiveStats";

const checks = [
  ["Session exists and is not revoked", "Owner can kill it with one post-quantum UserOperation"],
  ["Not expired", "Returned as validUntil, so the EntryPoint enforces it"],
  ["Amount ≤ per-payment cap", "One bad decision costs at most one cap"],
  ["Spent + amount ≤ budget", "Runaway loops stop at the budget"],
  ["Payee is on the allowlist", "Prompt-injected redirects bounce"],
  ["WOTS signature + Merkle path verify", "Hash-based, so a quantum computer can't forge it"],
  ["One-time key not used before", "Each key signs exactly one payment"],
];

export default function Home() {
  return (
    <div className="space-y-24 pt-10 sm:pt-16">
      <section className="grid items-center gap-10 lg:grid-cols-[1.15fr_1fr]">
        <div>
          <span className="chip">Aevum Builder Challenge · Native AI Assistants</span>
          <h1 className="mt-5 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
            Your AI agent&apos;s wallet key won&apos;t survive Q-Day.{" "}
            <span className="text-mint">Its Hashgate session will.</span>
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-mute sm:text-lg">
            Hashgate gives an AI agent a tUSD8 budget in an ERC-4337 smart account on QDay Aevum. Every UserOperation is signed with a
            hash-based one-time key instead of ECDSA, sent through QDay&apos;s own bundler, and gas is sponsored. Caps, budget, expiry, a payee
            allowlist and instant revoke are enforced in the account&apos;s validation, not the prompt.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/console" className="btn btn-primary">Try it, no wallet needed →</Link>
            <a href="#how" className="btn btn-ghost">How it works</a>
          </div>
          <p className="mt-4 text-xs text-dim">Takes about a minute. Gas is sponsored by the Hashgate paymaster and new accounts get 0.05 test tUSD8.</p>
        </div>
        <SignatureArt />
      </section>

      <LiveStats />

      <section className="grid gap-4 md:grid-cols-3">
        <Problem title="Agents hold keys that do too much" body="Most agent wallets hand the model a private key or an ECDSA session key. One prompt injection or one leaked env var and the whole balance can move." />
        <Problem title="ECDSA has an expiry date" body="secp256k1 falls to Shor's algorithm. Every public key already on-chain can be harvested now and forged later. That day is “Q-Day”." />
        <Problem title="QDay is post-quantum. Apps should be too." body="Aevum is built for the post-quantum era. Hashgate moves the spending decision itself onto hash-based signatures, verified in plain Solidity today." />
      </section>

      <section id="how" className="scroll-mt-24">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">How it works</h2>
        <p className="mt-2 max-w-2xl text-mute">Two key trees, one ERC-4337 account, QDay&apos;s bundler, no trusted server.</p>
        <Flow />
      </section>

      <section className="grid gap-8 lg:grid-cols-2">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">What validateUserOp checks, every payment</h2>
          <p className="mt-2 text-mute">Inside the account&apos;s ERC-4337 validation, so the bundler refuses a bad payment before it is ever included. Each refusal is a named error the app explains.</p>
          <ol className="mt-5 space-y-2">
            {checks.map(([a, b], i) => (
              <li key={a} className="card flex gap-3 p-3">
                <span className="mono mt-0.5 text-xs text-mint">{String(i + 1).padStart(2, "0")}</span>
                <div><div className="text-sm font-medium">{a}</div><div className="text-xs text-mute">{b}</div></div>
              </li>
            ))}
          </ol>
        </div>
        <div className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">Why one-time signatures</h2>
          <div className="card space-y-3 p-5 text-sm leading-relaxed text-mute">
            <p><b className="text-ink">WOTS</b> (Winternitz one-time signatures) need nothing but a hash function. Security rests on keccak256 preimage resistance, which Shor&apos;s algorithm doesn&apos;t touch and Grover only halves (256 → ~128 bits).</p>
            <p>Each signature is 67 hash-chain values (2,144 bytes) over the userOpHash. The account walks the chains, hashes the result into a leaf and checks a Merkle path to the committed root. A full agent payment UserOperation costs about <b className="text-ink">270k–310k gas</b>, roughly 0.0003 tQDAY, sponsored.</p>
            <p>A key can sign once, so a session is a Merkle tree of 64 keys: one per payment. The owner tree has 32 keys and can rotate to a fresh one.</p>
          </div>
          <div className="card space-y-2 p-5 text-sm text-mute">
            <div className="font-medium text-ink">Honest limits</div>
            <p>tUSD8 itself is still an ECDSA token: Hashgate protects funds once they are inside the account. Seeds live in your browser on this testnet demo. Sessions have a fixed number of payments.</p>
          </div>
        </div>
      </section>

      <section className="card flex flex-col items-start justify-between gap-4 p-6 sm:flex-row sm:items-center">
        <div>
          <div className="text-lg font-semibold">Run the agent, then try to break it.</div>
          <div className="text-sm text-mute">Create a smart account, open a session, let the agent pay invoices, feed it a poisoned one, revoke it.</div>
        </div>
        <Link href="/console" className="btn btn-primary">Open the console →</Link>
      </section>
    </div>
  );
}

function Problem({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-5">
      <div className="font-medium">{title}</div>
      <p className="mt-2 text-sm leading-relaxed text-mute">{body}</p>
    </div>
  );
}

function Flow() {
  const box = "card p-4 text-sm";
  return (
    <div className="mt-6 grid gap-3 lg:grid-cols-[1fr_auto_1.2fr_auto_1fr] lg:items-stretch">
      <div className={box}>
        <div className="label">OWNER · your browser</div>
        <div className="mt-1 font-medium">Owner key tree</div>
        <p className="mt-1 text-mute">32 one-time keys from a seed that never leaves the device. Signs the userOpHash of: open session, revoke, withdraw, rotate.</p>
      </div>
      <Arrow label="UserOp → bundler" />
      <div className={`${box} border-mint/40`}>
        <div className="label text-mint">HASHGATE ACCOUNT · ERC-4337 on Aevum</div>
        <div className="mt-1 font-medium">validateUserOp: WOTS, not ECDSA</div>
        <p className="mt-1 text-mute">Holds tUSD8. Verifies WOTS + Merkle paths in Solidity, burns used keys, enforces cap / budget / allowlist and returns expiry as validUntil. Gas from the Hashgate paymaster. No ECDSA owner.</p>
      </div>
      <Arrow label="pays vendor" />
      <div className={box}>
        <div className="label">VENDOR</div>
        <div className="mt-1 font-medium">tUSD8 arrives</div>
        <p className="mt-1 text-mute">With an on-chain receipt: session, invoice memo hash and the one-time key index.</p>
      </div>
      <div className={`${box} lg:col-start-3`}>
        <div className="label">AI AGENT · session key tree</div>
        <div className="mt-1 font-medium">Reads invoices, signs payments</div>
        <p className="mt-1 text-mute">64 one-time keys, one per payment, and it may only call agentPay. A compromised agent can only spend inside the policy; the bundler rejects anything else.</p>
      </div>
    </div>
  );
}

function Arrow({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 text-xs text-dim lg:flex-col">
      <span className="mono">{label}</span>
      <span aria-hidden className="text-mint lg:rotate-0">→</span>
    </div>
  );
}

function SignatureArt() {
  // 67 hash chains of a real-looking signature: each column's height is its digit (0–15).
  const digits = Array.from({ length: 67 }, (_, i) => (i * 7 + ((i * i) % 11)) % 16);
  return (
    <div className="card p-5" aria-label="Illustration of a WOTS signature: 67 hash chains">
      <div className="flex items-center justify-between text-xs text-mute">
        <span className="mono">WOTS signature · 67 chains × 15 steps</span>
        <span className="chip">2,144 bytes</span>
      </div>
      <div className="mt-4 flex h-44 items-end gap-[3px]">
        {digits.map((d, i) => (
          <div key={i} className="flex flex-1 flex-col-reverse gap-[2px]">
            {Array.from({ length: 15 }, (_, j) => (
              <div key={j} className="h-[9px] rounded-[2px]" style={{ background: j < d ? "var(--color-mint)" : "var(--color-line)", opacity: j < d ? 0.35 + (j / 15) * 0.65 : 1 }} />
            ))}
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs leading-relaxed text-dim">
        The signer walks each chain <span className="text-mint">d</span> steps from a secret start; the verifier walks the remaining 15 − d. A checksum stops anyone from walking a chain further to forge a different message.
      </p>
    </div>
  );
}
