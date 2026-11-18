"use client";
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { explorerAddress, explorerTx } from "@hashgate/sdk";
import { HASHGATE, vendorName } from "@/lib/config";

type Ev = { event: string; args: Record<string, string | string[]>; block: string; tx: string; time?: number };

const LABEL: Record<string, string> = {
  VaultCreated: "Vault created", Deposited: "Deposit", SessionOpened: "Session opened", SessionRevoked: "Session revoked",
  AgentPaid: "Agent payment", Withdrawn: "Withdrawal", OwnerKeyRotated: "Owner key rotated",
};
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;

function describe(e: Ev): string {
  const a = e.args;
  const amt = (x?: string | string[]) => (x ? `${formatUnits(BigInt(x as string), 6)} tUSD8` : "");
  switch (e.event) {
    case "VaultCreated": return `vault ${short(a.vaultId as string)} · ${2 ** Number(a.height)} one-time owner keys`;
    case "Deposited": return `${amt(a.amount)} into ${short(a.vaultId as string)}`;
    case "SessionOpened": return `cap ${amt(a.maxPerPayment)} · budget ${amt(a.budget)} · ${(a.payees as string[]).length || "any"} payee(s) · owner key #${a.ownerLeaf}`;
    case "SessionRevoked": return `session ${short(a.sessionId as string)} · owner key #${a.ownerLeaf}`;
    case "AgentPaid": return `${amt(a.amount)} → ${vendorName(a.to as string) ?? short(a.to as string)} · session key #${a.sessionLeaf}`;
    case "Withdrawn": return `${amt(a.amount)} → ${short(a.to as string)} · owner key #${a.ownerLeaf}`;
    case "OwnerKeyRotated": return `new root ${short(a.root as string)}`;
    default: return "";
  }
}

export function Activity() {
  const [evs, setEvs] = useState<Ev[] | null>(null);
  const [err, setErr] = useState("");
  const [source, setSource] = useState("");
  useEffect(() => {
    const load = () => fetch("/api/activity").then((r) => r.json()).then((b) => {
      if (!b.ok) throw new Error(b.message);
      setEvs(b.events); setSource(b.source); setErr("");
    }).catch((e) => setErr(String(e.message || e)));
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="pt-8">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">On-chain activity</h1>
      <p className="mt-1 text-sm text-mute">
        Every Hashgate event on Aevum testnet, newest first. Contract{" "}
        <a className="link mono break-all" href={explorerAddress(HASHGATE)} target="_blank" rel="noreferrer">{HASHGATE}</a>
        {source && <span className="text-dim"> · read via {source === "explorer" ? "Aevum explorer API" : "RPC (last 1,000 blocks)"}</span>}
      </p>
      {err && <p className="mt-4 text-sm text-amber">Couldn&apos;t load events: {err}</p>}
      {!evs ? <p className="mt-8 text-mute">Loading…</p> : evs.length === 0 ? <p className="mt-8 text-mute">No events yet.</p> : (
        <ul className="mt-6 divide-y divide-line overflow-hidden rounded-xl border border-line">
          {evs.map((e, i) => (
            <li key={`${e.tx}-${i}`} className="flex flex-col gap-1 bg-panel px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <span className={`chip mr-2 ${e.event === "AgentPaid" ? "border-mint/50 text-mint" : e.event === "SessionRevoked" ? "border-rose/50 text-rose" : ""}`}>{LABEL[e.event] ?? e.event}</span>
                <span className="text-sm text-mute">{describe(e)}</span>
              </div>
              <div className="flex shrink-0 gap-3 text-xs text-dim">
                {e.time ? <span>{new Date(e.time * 1000).toLocaleString()}</span> : <span>block {e.block}</span>}
                <a className="link mono" href={explorerTx(e.tx)} target="_blank" rel="noreferrer">{short(e.tx)} ↗</a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
