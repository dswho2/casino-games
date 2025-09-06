import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ChipStack from "../components/ChipStack";
import Button from "../components/Button";
import { api } from "../api/client";
import { useAuthStore } from "../store/auth";
import { amountCentsToDenoms } from "../components/chips";

const PRESETS = [5, 20, 50, 100, 500, 1000, 2500, 5000];

export default function Wallet() {
  const me = useAuthStore(s => s.me);
  const fetchMe = useAuthStore(s => s.fetchMe);
  const [selectedCents, setSelectedCents] = useState(0);
  const [selectedSource, setSelectedSource] = useState<"preset" | "custom" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [flying, setFlying] = useState<{ id:number; x:number; y:number; dx:number; dy:number; delay:number; value:number }[]>([]);
  const startRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => { fetchMe(); }, [fetchMe]);
  function addQuick(dollars: number){ setSelectedSource("preset"); setSelectedCents(dollars * 100); }
  function clearAll(){ setSelectedCents(0); setErr(null); }

  async function commitDeposit(){
    if (selectedCents <= 0) return;
    setBusy(true); setErr(null);
    try {
      const amount = selectedCents; // capture before reset
      await api<{ balance_cents: number }>(`/wallet/deposit`, { method: "POST", body: JSON.stringify({ amount_cents: amount, password }) });
      await fetchMe();
      // Reset after commit
      setSelectedCents(0); setPassword(""); setConfirmOpen(false);
      // Chip flight from selected card to navbar balance
      const target = document.getElementById('nav-balance-target');
      const key = PRESETS.includes(amount/100) ? `preset-${amount/100}` : 'custom';
      const startEl = startRefs.current[key] ?? null;
      if (target && startEl) launchFlight(amount, startEl, target);
    } catch (e:any) {
      setErr(e?.message ?? "Failed to deposit");
    } finally {
      setBusy(false);
    }
  }

  function launchFlight(amountCents: number, startEl: HTMLElement, endEl: HTMLElement){
    const s = startEl.getBoundingClientRect();
    const e = endEl.getBoundingClientRect();
    const chipSize = 24;
    const startX = s.left + s.width/2 - chipSize/2;
    const startY = s.top + s.height/2 - chipSize/2;
    const endX = e.left + e.width/2 - chipSize/2;
    const endY = e.top + e.height/2 - chipSize/2;
    const dx = endX - startX;
    const dy = endY - startY;
    const vals = amountCentsToDenoms(amountCents, 12);
    const interDelay = 70;
    const chips = vals.map((val, i) => ({ id: Date.now() + i, x: startX, y: startY, dx, dy, delay: i * interDelay, value: val }));
    setFlying(chips);
    const lastDelay = chips.length ? chips[chips.length - 1].delay : 0;
    const clearAfter = lastDelay + 520;
    window.setTimeout(() => setFlying([]), clearAfter);
  }

  return (
    <div className="p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <header className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-extrabold">Wallet</h1>
            <div className="text-white/70">Choose an amount to add</div>
          </div>
        </header>

        {/* Amount options */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {PRESETS.map((v) => {
            const cents = v * 100;
            const active = selectedSource === "preset" && selectedCents === cents;
            return (
              <motion.button
                key={v}
                onClick={() => addQuick(v)}
                whileHover={{ y: -3 }}
                className={`text-left rounded-2xl bg-card border ${active ? 'border-accent' : 'border-white/10 hover:border-white/20'} p-4 flex items-center justify-between`}
              >
                <div>
                  <div className="text-sm text-white/70">Add</div>
                  <div className="text-2xl font-extrabold">${v}</div>
                </div>
                <div ref={el => (startRefs.current[`preset-${v}`] = el)} className="relative right-2">
                  <ChipStack amountCents={cents} chipSize={48} maxColumns={2} />
                </div>
              </motion.button>
            );
          })}
          {/* Custom input card */}
          {(() => {
            const activeCustom = selectedSource === "custom";
            return (
              <motion.button
                type="button"
                onClick={() => setSelectedSource("custom")}
                whileHover={{ y: -3 }}
                className={`text-left rounded-2xl bg-card border ${activeCustom ? 'border-accent' : 'border-white/10 hover:border-white/20'} p-4 flex items-center justify-between`}
              >
                <div>
                  <div className="text-sm text-white/70">Custom</div>
                  <input
                    type="number"
                    inputMode="numeric"
                    placeholder="$"
                    className="mt-1 rounded-lg bg-bg px-3 py-2 border border-white/10 outline-none focus:ring-2 focus:ring-accent w-32"
                    onFocus={() => setSelectedSource("custom")}
                    onChange={(e) => {
                      const v = Math.max(0, Math.floor(Number(e.target.value || '0')));
                      setSelectedCents(v * 100);
                      setSelectedSource("custom");
                    }}
                  />
                </div>
                <div ref={el => (startRefs.current['custom'] = el)} className="relative right-2">
                  <ChipStack amountCents={selectedCents} chipSize={48} maxColumns={2} maxPerColumn={9} />
                </div>
              </motion.button>
            );
          })()}
        </div>

        {/* Footer actions */}
        <div className="mt-6 flex items-center gap-3">
          <Button onClick={() => setConfirmOpen(true)} disabled={busy || selectedCents <= 0} className="disabled:opacity-50">
            {busy ? 'Processing...' : `Add ${(selectedCents/100).toFixed(2)}`}
          </Button>
          <Button onClick={clearAll} variant="secondary">Clear</Button>
          {err && <div className="text-danger text-sm ml-2">{err}</div>}
        </div>

        {/* Password modal */}
        <AnimatePresence>
          {confirmOpen && (
            <motion.div className="fixed inset-0 z-50 flex items-center justify-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="absolute inset-0 bg-black/60" onClick={() => (!busy && setConfirmOpen(false))} />
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 10, opacity: 0 }}
                transition={{ type: 'spring', stiffness: 300, damping: 26 }}
                className="relative rounded-2xl bg-card border border-white/10 p-6 w-[min(92vw,420px)]"
              >
                <div className="text-xl font-bold mb-1">Confirm Payment</div>
                <div className="text-white/70 text-sm mb-4">Enter your mom's credit card number to add ${ (selectedCents/100).toFixed(2) } to your balance.</div>
                <label className="block text-sm text-white/80 mb-1" htmlFor="pw">Password</label>
                <input id="pw" type="password" className="w-full rounded-lg bg-bg px-3 py-2 border border-white/10 outline-none focus:ring-2 focus:ring-accent" value={password} onChange={(e) => setPassword(e.target.value)} />
                <div className="flex justify-end gap-2 mt-4">
                  <Button onClick={() => setConfirmOpen(false)} variant="secondary">Cancel</Button>
                  <Button onClick={commitDeposit} disabled={busy || !password} className="disabled:opacity-50">{busy ? 'Processing...' : 'Confirm'}</Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {/* Chip flight overlay */}
      <div className="pointer-events-none fixed inset-0 z-50">
        <AnimatePresence initial={false}>
          {flying.map(ch => (
            <motion.div
              key={ch.id}
              initial={{ x: ch.x, y: ch.y, opacity: 0, scale: 0.9 }}
              animate={{ x: ch.x + ch.dx, y: ch.y + ch.dy, opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.18 } }}
              transition={{ delay: ch.delay/1000, duration: 0.5, ease: "easeOut" }}
              className="absolute"
            >
              <ChipStack amountCents={ch.value * 100} chipSize={32} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
