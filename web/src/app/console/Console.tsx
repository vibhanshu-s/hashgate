"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, getAddress, isAddress, type Address, type Hex } from "viem";
import { REASONS, explorerAddress, explorerTx } from "@hashgate/sdk";
import { ATTACKER, DRIP_AMOUNT, VENDORS, vendorName } from "@/lib/config";
import {
  AGENT_HEIGHT, OWNER_HEIGHT, activeVault, agentPay, checkPayment, createAccount, forgedWithdraw, loadStore,
  newVaultKeys, openSession as openSessionOp, readSession, readVault, resend, revokeSession, saveStore, usd,
  withdraw as withdrawOp, type OpResult, type Store, type StoredSession, type StoredVault,
} from "@/lib/client";
import { INVOICES } from "./invoices";
import { depositWithWallet } from "./wallet";

type LogKind = "ok" | "blocked" | "info" | "error";
type LogEntry = { id: number; t: number; kind: LogKind; title: string; detail?: string; tx?: Hex };
type Proposal = { invoiceId: string; to: Address; amount: string; memo: string; reasoning: string; source: string };
type RunRow = Proposal & { status: "checking" | "signing" | "sending" | "paid" | "blocked" | "error"; reason?: string; tx?: Hex; leaf?: number; gas?: string; signedOp?: Record<string, string>; forcedTx?: Hex; via?: string };

const fmt = (x: bigint | string) => formatUnits(BigInt(x), 6);
const short = (h: string, n = 6) => `${h.slice(0, n + 2)}…${h.slice(-4)}`;
const why = (r: OpResult) => `${r.code ? `${r.code} · ` : ""}${r.error ?? "Rejected"}: ${r.message ?? ""}`;

export function Console() {
  const [store, setStore] = useState<Store>({ v: 2, vaults: [] });
  const [hydrated, setHydrated] = useState(false);
  const [chain, setChain] = useState<{ balance: bigint; ownerUsed: number; exists: boolean } | null>(null);
  const [sessionChain, setSessionChain] = useState<Record<string, { spent: bigint; revoked: boolean; expiresAt: number; leavesUsed: number; payments: number }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const logId = useRef(0);

  useEffect(() => {
    setStore(loadStore());
    setHydrated(true);
  }, []);

  const vault = activeVault(store);
  const persist = useCallback((fn: (v: StoredVault) => void) => {
    setStore((s) => {
      const next = structuredClone(s);
      const v = activeVault(next);
      if (v) fn(v);
      saveStore(next);
      return next;
    });
  }, []);
  const reserveOwner = useCallback((n: number) => persist((v) => { v.nextOwnerLeaf = Math.max(v.nextOwnerLeaf, n); }), [persist]);
  const reserveSession = useCallback((sid: Hex) => (n: number) => persist((v) => {
    const x = v.sessions.find((q) => q.sessionId === sid);
    if (x) x.nextLeaf = Math.max(x.nextLeaf, n);
  }), [persist]);

  const push = useCallback((kind: LogKind, title: string, detail?: string, tx?: Hex) => {
    setLog((l) => [{ id: ++logId.current, t: Date.now(), kind, title, detail, tx }, ...l].slice(0, 60));
  }, []);

  const refresh = useCallback(async () => {
    if (!vault) return;
    try {
      const v = await readVault(vault.account);
      setChain({ balance: v.balance, ownerUsed: v.ownerLeavesUsed, exists: v.exists });
      if (!v.exists) return;
      const entries = await Promise.all(vault.sessions.map(async (s) => [s.sessionId, await readSession(vault.account, s.sessionId)] as const));
      setSessionChain(Object.fromEntries(entries.filter(([, s]) => s.exists).map(([id, s]) => [id, {
        spent: s.spent, revoked: s.revoked, expiresAt: Number(s.expiresAt), leavesUsed: s.leavesUsed, payments: s.payments,
      }])));
    } catch {
      /* RPC hiccup: keep the last known state */
    }
  }, [vault]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);

  const opLog = (r: OpResult) => (r.via ? `via ${r.via}` : "");

  // ── step 1: smart account ──
  async function createVault() {
    setBusy("vault");
    try {
      push("info", "Deriving your owner key", `${2 ** OWNER_HEIGHT} one-time WOTS keys from a fresh seed, in this browser.`);
      await new Promise((r) => setTimeout(r, 30));
      const v = await newVaultKeys();
      setStore((s) => {
        const next: Store = { ...s, vaults: [...s.vaults, v], active: v.account };
        saveStore(next);
        return next;
      });
      const r = await createAccount(v);
      if (!r.ok) throw new Error(r.message || "Could not create the account.");
      persist((x) => { x.createdTx = r.hash; });
      push("ok", "Smart account deployed on Aevum", `ERC-4337 account ${short(v.account)}, owned by your post-quantum key root. No ECDSA owner.`, r.hash);
      if (r.drip?.hash) push("ok", `Demo treasury sent ${fmt(DRIP_AMOUNT)} tUSD8`, "So you can try the agent without a wallet. Gas is sponsored by the Hashgate paymaster.", r.drip.hash);
      else if (r.drip?.message) push("info", "No demo funds this time", r.drip.message);
      await refresh();
    } catch (e) {
      push("error", "Account creation failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function backup() {
    if (!vault) return;
    const blob = new Blob([JSON.stringify({ hashgate: "v2", warning: "Testnet key backup. Anyone with this file controls the account.", vault }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `hashgate-account-${vault.account.slice(2, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function restore(file: File) {
    file.text().then((t) => {
      try {
        const v = JSON.parse(t).vault as StoredVault;
        if (!v?.account || !v.ownerSeed) throw new Error();
        setStore((s) => {
          const next: Store = { ...s, vaults: [...s.vaults.filter((x) => x.account !== v.account), v], active: v.account };
          saveStore(next);
          return next;
        });
        push("ok", "Account restored from backup", short(v.account));
      } catch {
        push("error", "That file is not a Hashgate v2 backup");
      }
    });
  }

  // ── step 2: session ──
  const [policy, setPolicy] = useState({ label: "Payables agent", maxPerPayment: "0.02", budget: "0.04", hours: 24, payees: VENDORS.map((v) => v.address as Address) });
  async function openSession() {
    if (!vault) return;
    setBusy("session");
    try {
      if (Number(policy.maxPerPayment) <= 0 || Number(policy.budget) < Number(policy.maxPerPayment)) throw new Error("The cap must be positive and no larger than the budget.");
      push("info", "Deriving the agent's session key", `${2 ** AGENT_HEIGHT} one-time keys: one per payment.`);
      await new Promise((r) => setTimeout(r, 30));
      const { session, r } = await openSessionOp(vault, policy.label, policy, reserveOwner);
      if (!r.ok) throw new Error(why(r));
      push("info", `Owner signed the UserOperation with one-time key #${r.leaf}`, "WOTS signature over the userOpHash: 2,144 bytes + Merkle path. No ECDSA involved.");
      persist((v) => { v.sessions = [{ ...session, openedTx: r.hash }, ...v.sessions]; });
      push("ok", "Agent session opened", `Cap ${policy.maxPerPayment} · budget ${policy.budget} tUSD8 · ${policy.hours}h · ${policy.payees.length || "any"} payee(s) · ${opLog(r)}`, r.hash);
      await refresh();
    } catch (e) {
      push("error", "Could not open the session", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function revoke(s: StoredSession) {
    if (!vault) return;
    setBusy(`revoke:${s.sessionId}`);
    try {
      const r = await revokeSession(vault, s, reserveOwner);
      if (!r.ok) throw new Error(why(r));
      persist((v) => { const x = v.sessions.find((q) => q.sessionId === s.sessionId); if (x) x.revoked = true; });
      push("ok", "Session revoked", `Owner UserOperation, one-time key #${r.leaf}. The agent's next operation fails validation. ${opLog(r)}`, r.hash);
      await refresh();
    } catch (e) {
      push("error", "Revoke failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // ── step 3: agent ──
  const session = vault?.sessions[0];
  const [selected, setSelected] = useState<string[]>(INVOICES.map((i) => i.id));
  const [compromised, setCompromised] = useState(true);
  const [rows, setRows] = useState<RunRow[]>([]);
  const [engine, setEngine] = useState<string>("");

  async function runAgent() {
    if (!vault || !session) return;
    setBusy("agent");
    setRows([]);
    try {
      const invoices = INVOICES.filter((i) => selected.includes(i.id)).map((i) => ({ id: i.id, text: i.text }));
      push("info", "Agent is reading the inbox", `${invoices.length} invoice(s)${compromised ? ", acting as a compromised model" : ""}.`);
      const res = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invoices, compromised }) }).then((r) => r.json());
      if (!res.ok) throw new Error(res.message);
      setEngine(res.engine);
      const list: RunRow[] = (res.proposals as Proposal[]).map((p) => ({ ...p, to: getAddress(p.to), status: "checking" }));
      setRows(list);
      // Sequential: each payment uses the next one-time key and the next EntryPoint nonce.
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        const update = (patch: Partial<RunRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
        let amount: bigint;
        try { amount = usd(p.amount); } catch { update({ status: "error", reason: "The agent proposed an invalid amount." }); continue; }
        const code = await checkPayment(vault.account, session.sessionId, p.to, amount);
        if (code !== 0) {
          // The account's own policy view says no: refuse before signing, so no one-time key is spent.
          update({ status: "blocked", reason: REASONS[code] });
          push("blocked", `Blocked: ${p.amount} tUSD8 → ${vendorName(p.to) ?? short(p.to)}`, `${REASONS[code]} (not signed)`);
          continue;
        }
        update({ status: "signing" });
        const current = activeVault(loadStore())?.sessions.find((x) => x.sessionId === session.sessionId) ?? session;
        const r = await agentPay(current, vault.account, p.to, amount, p.memo, reserveSession(session.sessionId));
        if (r.ok) {
          update({ status: "paid", tx: r.hash, gas: r.gasUsed, leaf: r.leaf, signedOp: r.signedOp, via: r.via });
          try { if (r.signedOp) localStorage.setItem("hashgate.lastPaidOp", JSON.stringify(r.signedOp)); } catch {}
          push("ok", `Paid ${p.amount} tUSD8 → ${vendorName(p.to) ?? short(p.to)}`, `${p.memo} · UserOperation signed with session key #${r.leaf} · ${r.gasUsed} gas · ${opLog(r)}`, r.hash);
        } else {
          update({ status: r.stage === "validation" || r.stage === "bundler" ? "blocked" : "error", reason: why(r), leaf: r.leaf });
          push("blocked", `Refused: ${p.amount} tUSD8 → ${vendorName(p.to) ?? short(p.to)}`, why(r));
        }
      }
      await refresh();
    } catch (e) {
      push("error", "Agent run failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function recordOnChain(i: number) {
    const row = rows[i];
    const v = activeVault(loadStore());
    const sess = v?.sessions[0];
    if (!row || !sess || !v) return;
    setBusy(`force:${i}`);
    try {
      // The bundler would never include this op. The relayer calls EntryPoint.handleOps directly,
      // so the account's refusal becomes a real reverted transaction on the explorer.
      const r = await agentPay(sess, v.account, row.to, usd(row.amount), row.memo, reserveSession(sess.sessionId), true);
      if (!r.hash) throw new Error(r.message ?? why(r));
      setRows((rs) => rs.map((x, j) => (j === i ? { ...x, forcedTx: r.hash, leaf: r.leaf } : x)));
      push("blocked", "Refusal recorded on-chain", `EntryPoint.handleOps reverted with the account's error. Session key #${r.leaf}.`, r.hash);
    } catch (e) {
      push("error", "Could not submit", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // ── step 4: drills ──
  const [drill, setDrill] = useState<Record<string, string>>({});
  async function qdayDrill() {
    if (!vault) return;
    setBusy("drill");
    try {
      // The attacker has every ECDSA key (relayer, deployer, your MetaMask) and a quantum computer.
      // What they don't have is a preimage of your hash chains, so they sign with their own WOTS key.
      const amount = chain?.balance && chain.balance > 0n ? chain.balance : usd("0.01");
      const r = await forgedWithdraw(vault, ATTACKER, amount);
      const msg = r.ok ? "Unexpected: the operation was accepted." : why(r);
      setDrill((d) => ({ ...d, qday: msg }));
      push(r.ok ? "error" : "blocked", `Q-Day drill: forged withdrawal of ${fmt(amount)} tUSD8`, msg);

      // Replay: resend one of the agent's real, already-included signed UserOperations.
      let replayOp = rows.find((x) => x.status === "paid" && x.signedOp)?.signedOp;
      if (!replayOp) {
        try { replayOp = JSON.parse(localStorage.getItem("hashgate.lastPaidOp") || "null") ?? undefined; } catch {}
      }
      if (replayOp && replayOp.sender?.toLowerCase() === vault.account.toLowerCase()) {
        const r2 = await resend(replayOp);
        const msg2 = r2.ok ? "Unexpected: the replay was accepted." : why(r2);
        setDrill((d) => ({ ...d, replay: msg2 }));
        push(r2.ok ? "error" : "blocked", "Drill: replay a real agent UserOperation", msg2);
      } else {
        setDrill((d) => ({ ...d, replay: "Run the agent first; this drill replays one of its real operations." }));
      }
    } catch (e) {
      push("error", "Drill failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // ── withdraw / deposit ──
  const [wTo, setWTo] = useState("");
  const [wAmt, setWAmt] = useState("0.01");
  async function withdraw() {
    if (!vault || !isAddress(wTo)) return push("error", "Enter a valid 0x address to withdraw to");
    setBusy("withdraw");
    try {
      const r = await withdrawOp(vault, getAddress(wTo), usd(wAmt), reserveOwner);
      if (!r.ok) throw new Error(why(r));
      push("ok", `Withdrew ${wAmt} tUSD8`, `To ${short(wTo)}, an owner UserOperation signed with one-time key #${r.leaf}.`, r.hash);
      await refresh();
    } catch (e) {
      push("error", "Withdraw failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const [dAmt, setDAmt] = useState("1");
  async function deposit() {
    if (!vault) return;
    setBusy("deposit");
    try {
      const hash = await depositWithWallet(vault.account, usd(dAmt), (m) => push("info", m));
      push("ok", `Sent ${dAmt} tUSD8 from your wallet`, "A plain tUSD8 transfer into your post-quantum account.", hash);
      await refresh();
    } catch (e) {
      push("error", "Deposit failed", (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const sc = session ? sessionChain[session.sessionId] : undefined;
  const sessionState = useMemo(() => {
    if (!session) return null;
    if (sc?.revoked || session.revoked) return "revoked";
    if (sc && sc.expiresAt * 1000 < Date.now()) return "expired";
    return sc ? "active" : "pending";
  }, [session, sc]);

  if (!hydrated) return <div className="py-20 text-center text-mute">Loading…</div>;

  return (
    <div className="grid gap-6 pt-8 lg:grid-cols-[1fr_360px]">
      <div className="min-w-0 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Console</h1>
          <p className="mt-1 text-sm text-mute">Every action is an ERC-4337 UserOperation, signed in this browser with a post-quantum one-time key and sent through QDay's bundler. Gas is sponsored by the Hashgate paymaster.</p>
        </header>

        {/* STEP 1 */}
        <Step n={1} title="Create a post-quantum smart account" done={!!chain?.exists}>
          {!vault || (!chain?.exists && !vault.createdTx) ? (
            <div className="space-y-3">
              <p className="text-sm text-mute">Generates a seed in this browser, derives {2 ** OWNER_HEIGHT} one-time WOTS keys, and deploys an ERC-4337 smart account owned by their Merkle root. No wallet, no gas, no sign-up.</p>
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-primary" onClick={createVault} disabled={!!busy}>{busy === "vault" ? <><span className="spinner" /> Creating…</> : "Create my account"}</button>
                <label className="btn btn-ghost cursor-pointer">Restore backup<input type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} /></label>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat k="Account balance" v={chain ? `${fmt(chain.balance)} tUSD8` : "…"} />
                <Stat k="Owner keys used" v={chain ? `${chain.ownerUsed} / ${2 ** vault.ownerHeight}` : "…"} />
                <Stat k="Smart account (ERC-4337)" v={short(vault.account)} mono href={explorerAddress(vault.account)} />
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-ghost" onClick={backup}>Download key backup</button>
                <button className="btn btn-ghost" onClick={createVault} disabled={!!busy}>New account</button>
                <details className="group w-full">
                  <summary className="btn btn-ghost w-fit cursor-pointer list-none">Deposit / withdraw</summary>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div className="card space-y-2 p-3">
                      <div className="label">Add tUSD8 from your wallet</div>
                      <div className="flex gap-2"><input className="field" value={dAmt} onChange={(e) => setDAmt(e.target.value)} inputMode="decimal" aria-label="Deposit amount" /><button className="btn btn-ghost shrink-0" disabled={!!busy} onClick={deposit}>{busy === "deposit" ? <span className="spinner" /> : "Deposit"}</button></div>
                      <p className="text-xs text-dim">A normal tUSD8 transfer from MetaMask or Rabby into your account. Your wallet pays a little tQDAY gas.</p>
                    </div>
                    <div className="card space-y-2 p-3">
                      <div className="label">Withdraw (owner UserOperation, post-quantum)</div>
                      <input className="field mono" placeholder="0x… destination" value={wTo} onChange={(e) => setWTo(e.target.value)} aria-label="Withdraw to address" />
                      <div className="flex gap-2"><input className="field" value={wAmt} onChange={(e) => setWAmt(e.target.value)} inputMode="decimal" aria-label="Withdraw amount" /><button className="btn btn-ghost shrink-0" disabled={!!busy} onClick={withdraw}>{busy === "withdraw" ? <span className="spinner" /> : "Withdraw"}</button></div>
                    </div>
                  </div>
                </details>
              </div>
              {store.vaults.length > 1 && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-mute">Your accounts:
                  {store.vaults.map((v) => (
                    <button key={v.account} className={`chip ${v.account === vault.account ? "border-mint text-mint" : ""}`} onClick={() => setStore((s) => { const n = { ...s, active: v.account }; saveStore(n); return n; })}>{short(v.account, 4)}</button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Step>

        {/* STEP 2 */}
        <Step n={2} title="Give the agent a scoped session" done={sessionState === "active"} disabled={!chain?.exists}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Per-payment cap (tUSD8)"><input className="field" value={policy.maxPerPayment} onChange={(e) => setPolicy({ ...policy, maxPerPayment: e.target.value })} inputMode="decimal" /></Field>
            <Field label="Total budget (tUSD8)"><input className="field" value={policy.budget} onChange={(e) => setPolicy({ ...policy, budget: e.target.value })} inputMode="decimal" /></Field>
            <Field label="Expires in (hours)"><input className="field" type="number" min={1} max={720} value={policy.hours} onChange={(e) => setPolicy({ ...policy, hours: Number(e.target.value) || 1 })} /></Field>
          </div>
          <fieldset className="mt-3">
            <legend className="label">Payee allowlist</legend>
            <div className="mt-2 flex flex-wrap gap-2">
              {VENDORS.map((v) => {
                const on = policy.payees.includes(v.address);
                return (
                  <button key={v.address} type="button" aria-pressed={on} onClick={() => setPolicy({ ...policy, payees: on ? policy.payees.filter((p) => p !== v.address) : [...policy.payees, v.address] })}
                    className={`chip px-3 py-1.5 ${on ? "border-mint/60 text-mint" : ""}`}>{on ? "✓" : "+"} {v.name}</button>
                );
              })}
            </div>
            {policy.payees.length === 0 && <p className="mt-2 text-xs text-amber">No allowlist: the agent could pay any address (within the caps).</p>}
          </fieldset>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button className="btn btn-primary" onClick={openSession} disabled={!!busy || !chain?.exists}>{busy === "session" ? <><span className="spinner" /> Signing & opening…</> : session ? "Open a new session" : "Sign & open session"}</button>
            <span className="text-xs text-dim">One owner UserOperation. The agent gets {2 ** AGENT_HEIGHT} keys of its own and may only call agentPay.</span>
          </div>
          {vault?.sessions.length ? (
            <ul className="mt-5 space-y-2">
              {vault.sessions.slice(0, 3).map((s, idx) => {
                const c = sessionChain[s.sessionId];
                const state = c?.revoked || s.revoked ? "revoked" : c && c.expiresAt * 1000 < Date.now() ? "expired" : c ? "active" : "pending";
                const spent = c ? Number(fmt(c.spent)) : 0;
                const budget = Number(fmt(s.policy.budget));
                return (
                  <li key={s.sessionId} className={`card p-3 ${idx > 0 ? "opacity-70" : ""}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-sm font-medium">{s.label}<StateChip state={state} />{idx === 0 && <span className="chip">in use</span>}</div>
                      {state === "active" && <button className="btn btn-danger py-1.5 text-xs" disabled={!!busy} onClick={() => revoke(s)}>{busy === `revoke:${s.sessionId}` ? <span className="spinner" /> : "Revoke now"}</button>}
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded bg-line" aria-label={`Spent ${spent} of ${budget}`}><div className="h-full bg-mint" style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} /></div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mute">
                      <span>Spent {spent} / {budget} tUSD8</span><span>Cap {fmt(s.policy.maxPerPayment)}</span>
                      <span>Keys used {c?.leavesUsed ?? 0} / {2 ** s.height}</span>
                      <span>Expires {new Date(Number(s.policy.expiresAt) * 1000).toLocaleString()}</span>
                      {s.openedTx && <a className="link" href={explorerTx(s.openedTx)} target="_blank" rel="noreferrer">open tx</a>}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </Step>

        {/* STEP 3 */}
        <Step n={3} title="Let the AI agent pay the inbox" disabled={!session}>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-bg p-3">
            <input type="checkbox" className="mt-1 accent-[var(--color-mint)]" checked={compromised} onChange={(e) => setCompromised(e.target.checked)} />
            <span className="text-sm"><b>Assume the model is compromised</b><span className="block text-xs text-mute">It obeys instructions hidden inside invoices. Hashgate shouldn&apos;t care: the chain decides what it may spend.</span></span>
          </label>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {INVOICES.map((inv) => {
              const on = selected.includes(inv.id);
              return (
                <div key={inv.id} className={`card p-3 ${on ? "" : "opacity-50"}`}>
                  <div className="flex items-start justify-between gap-2">
                    <label className="flex cursor-pointer items-start gap-2">
                      <input type="checkbox" className="mt-1" checked={on} onChange={() => setSelected(on ? selected.filter((x) => x !== inv.id) : [...selected, inv.id])} />
                      <span><span className="text-sm font-medium">{inv.vendor}</span><span className="block text-xs text-mute">{inv.title}</span></span>
                    </label>
                    {inv.tag === "poisoned" && <span className="chip border-rose/50 text-rose">hidden instruction</span>}
                    {inv.tag === "over-cap" && <span className="chip border-amber/50 text-amber">above cap</span>}
                  </div>
                  <details className="mt-2"><summary className="cursor-pointer text-xs text-dim">View invoice text</summary><pre className="mono mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-bg p-2 text-[11px] leading-relaxed text-mute">{inv.text}</pre></details>
                </div>
              );
            })}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button className="btn btn-primary" onClick={runAgent} disabled={!!busy || !session || selected.length === 0}>{busy === "agent" ? <><span className="spinner" /> Agent working…</> : "Run the agent"}</button>
            {engine && <span className="text-xs text-dim">Read by: {engine}</span>}
          </div>
          {rows.length > 0 && (
            <ul className="mt-4 space-y-2" aria-live="polite">
              {rows.map((r, i) => (
                <li key={i} className={`card p-3 ${r.status === "blocked" ? "border-rose/40" : r.status === "paid" ? "border-mint/40" : ""}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm"><b>{r.amount} tUSD8</b> → {vendorName(r.to) ?? <span className="mono">{short(r.to)}</span>} <span className="text-xs text-dim">({r.memo})</span></div>
                    <RowStatus s={r.status} />
                  </div>
                  <p className="mt-1 text-xs text-mute">Agent: “{r.reasoning}”</p>
                  {r.reason && <p className="mt-1 text-xs text-rose">Hashgate: {r.reason}</p>}
                  <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-dim">
                    {r.leaf !== undefined && <span>one-time key #{r.leaf}</span>}
                    {r.gas && <span>{r.gas} gas</span>}
                    {r.tx && <a className="link" href={explorerTx(r.tx)} target="_blank" rel="noreferrer">view transaction</a>}
                    {r.status === "blocked" && !r.forcedTx && <button className="link text-sky underline" disabled={!!busy} onClick={() => recordOnChain(i)}>{busy === `force:${i}` ? "submitting…" : "sign & record this refusal on-chain"}</button>}
                    {r.forcedTx && <a className="link" href={explorerTx(r.forcedTx)} target="_blank" rel="noreferrer">reverted tx on explorer</a>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Step>

        {/* STEP 4 */}
        <Step n={4} title="Try to break it" disabled={!chain?.exists}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="card p-3">
              <div className="text-sm font-medium">Q-Day drill</div>
              <p className="mt-1 text-xs text-mute">Pretend a quantum computer cracked every ECDSA key: the relayer, the deployer, your MetaMask. The attacker signs a UserOperation to drain the account, and replays one of the agent's real operations. The QDay bundler rejects both.</p>
              <button className="btn btn-ghost mt-3" disabled={!!busy} onClick={qdayDrill}>{busy === "drill" ? <span className="spinner" /> : "Run the attack"}</button>
              {drill.qday && <p className="mt-2 text-xs text-rose">Withdrawal: {drill.qday}</p>}
              {drill.replay && <p className="mt-1 text-xs text-rose">Replay: {drill.replay}</p>}
            </div>
            <div className="card p-3">
              <div className="text-sm font-medium">Revoke, then run again</div>
              <p className="mt-1 text-xs text-mute">Hit “Revoke now” on the session in step 2, then run the agent. The agent's payments are refused: the account reports SessionIsRevoked.</p>
              {session && sessionState === "active" && <button className="btn btn-danger mt-3" disabled={!!busy} onClick={() => revoke(session)}>Revoke current session</button>}
              {sessionState === "revoked" && <p className="mt-3 text-xs text-mint">Session is revoked. Run the agent to see it refused.</p>}
            </div>
          </div>
        </Step>
      </div>

      {log[0] && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-panel/95 px-4 py-2.5 backdrop-blur lg:hidden" role="status" aria-live="polite">
          <div className="flex items-center gap-2 text-sm">
            {busy ? <span className="spinner text-mint" /> : <Dot kind={log[0].kind} />}
            <span className="min-w-0 flex-1 truncate font-medium">{log[0].title}</span>
            {log[0].tx && <a className="link mono shrink-0 text-xs" href={explorerTx(log[0].tx)} target="_blank" rel="noreferrer">tx ↗</a>}
          </div>
        </div>
      )}
      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <div className="card p-4">
          <div className="label">Live log</div>
          {log.length === 0 ? <p className="mt-2 text-sm text-dim">Actions and transactions show up here.</p> : (
            <ol className="mt-3 max-h-[60vh] space-y-3 overflow-y-auto pr-1">
              {log.map((e) => (
                <li key={e.id} className="flex gap-2 text-sm">
                  <Dot kind={e.kind} />
                  <div className="min-w-0">
                    <div className="font-medium leading-snug">{e.title}</div>
                    {e.detail && <div className="text-xs text-mute">{e.detail}</div>}
                    {e.tx && <a className="link mono text-xs" href={explorerTx(e.tx)} target="_blank" rel="noreferrer">{short(e.tx, 8)} ↗</a>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="card p-4 text-xs leading-relaxed text-mute">
          <div className="label mb-1">Where are my keys?</div>
          Seeds are stored in this browser (localStorage) and never sent anywhere. The server only estimates gas; this page recomputes the userOpHash before signing. Download a backup to keep the account.
        </div>
      </aside>
    </div>
  );
}

function Step({ n, title, done, disabled, children }: { n: number; title: string; done?: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <section className={`card p-4 sm:p-5 ${disabled ? "opacity-55" : ""}`} aria-disabled={disabled}>
      <h2 className="mb-3 flex items-center gap-3 text-lg font-semibold">
        <span className={`mono flex h-7 w-7 items-center justify-center rounded-full border text-xs ${done ? "border-mint bg-mint text-mint-ink" : "border-line text-mute"}`}>{done ? "✓" : n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}
function Stat({ k, v, mono, href }: { k: string; v: string; mono?: boolean; href?: string }) {
  return <div className="rounded-lg border border-line bg-bg p-3"><div className="text-xs text-mute">{k}</div><div className={`mt-0.5 font-semibold ${mono ? "mono text-sm" : ""}`}>{href ? <a className="link" href={href} target="_blank" rel="noreferrer">{v} ↗</a> : v}</div></div>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-1"><span className="label">{label}</span>{children}</label>;
}
function StateChip({ state }: { state: string }) {
  const c = state === "active" ? "border-mint/50 text-mint" : state === "revoked" ? "border-rose/50 text-rose" : "text-mute";
  return <span className={`chip ${c}`}>{state}</span>;
}
function RowStatus({ s }: { s: RunRow["status"] }) {
  const map: Record<RunRow["status"], [string, string]> = {
    checking: ["checking policy", "text-mute"], signing: ["signing (WOTS)", "text-sky"], sending: ["settling on Aevum", "text-sky"],
    paid: ["paid", "text-mint"], blocked: ["blocked", "text-rose"], error: ["error", "text-amber"],
  };
  const [label, cls] = map[s];
  return <span className={`chip ${cls}`}>{["checking", "signing", "sending"].includes(s) && <span className="spinner" />}{label}</span>;
}
function Dot({ kind }: { kind: LogKind }) {
  const c = { ok: "bg-mint", blocked: "bg-rose", info: "bg-sky", error: "bg-amber" }[kind];
  return <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${c}`} aria-hidden />;
}

