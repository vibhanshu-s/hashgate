"use client";
import { useEffect, useState } from "react";

type Ev = { event: string };

export function LiveStats() {
  const [s, setS] = useState<{ vaults: number; payments: number; blocked?: number; locked?: string; block?: string; gas?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [a, st] = await Promise.all([fetch("/api/activity").then((r) => r.json()), fetch("/api/status").then((r) => r.json())]);
        const ev: Ev[] = a.events ?? [];
        if (alive) setS({
          vaults: ev.filter((e) => (e.event === "VaultCreated" || e.event === "AccountCreated")).length,
          payments: ev.filter((e) => e.event === "AgentPaid").length,
          locked: st.lockedUsd, block: st.block, gas: st.paymasterDeposit ? Number(st.paymasterDeposit).toFixed(3) : undefined,
        });
      } catch {
        if (alive) setS({ vaults: 0, payments: 0 });
      }
    })();
    return () => { alive = false; };
  }, []);
  const items = [
    ["Accounts & vaults on Aevum", s ? String(s.vaults) : "…"],
    ["PQ-signed agent payments", s ? String(s.payments) : "…"],
    ["Sponsored gas left (tQDAY)", s?.gas ?? "…"],
    ["ECDSA keys with authority", "0"],
  ];
  return (
    <section aria-label="Live on-chain stats" className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map(([k, v]) => (
        <div key={k} className="card p-4">
          <div className="mono text-2xl font-semibold text-ink">{v}</div>
          <div className="mt-1 text-xs text-mute">{k}</div>
        </div>
      ))}
    </section>
  );
}
