import { useEffect, useState } from "react";
import { api } from "../../api/client";
import Card from "../../components/Card";
import Button from "../../components/Button";
import ChipSelector from "../../components/ChipSelector";
import { motion, AnimatePresence } from "framer-motion";

type Me = { username: string; balance_cents: number };
type Hand = { cards: { r: string, s: "S"|"H"|"D"|"C" }[], value: number, soft: boolean };
type Round = {
  id: number; status: string; bet_cents: number;
  dealer_hand: Hand; player_hand: Hand;
  outcome?: string; payout_cents?: number; balance_cents: number;
};


export default function BlackjackTable() {
  const [me, setMe] = useState<{username:string,balance_cents:number}|null>(null);
  const [round, setRound] = useState<Round|null>(null);
  const [bet, setBet] = useState(500);
  const [msg, setMsg] = useState<string | null>(null);

  async function refreshMe() { try { const m = await api<Me>("/me"); setMe(m); } catch { console.debug("GET /me failed, probably not authed"); } }

  useEffect(() => { refreshMe(); }, []);

  async function start() {
    const r = await api<Round>("/game/start", { method:"POST", body: JSON.stringify({ bet_cents: bet }) });
    setRound(r); setMsg(null); refreshMe();
  }
  async function doAction(action: "hit"|"stand"|"double"|"surrender") {
    if (!round) return;
    const r = await api<Round>("/game/action", { method:"POST", body: JSON.stringify({ round_id: round.id, action }) });
    setRound(r); setMsg(r.outcome ? `Round settled: ${r.outcome}` : null); refreshMe();
  }

  const canAct = round && round.status === "in_progress" && !round.outcome;

  return (
    <div className="flex flex-col items-center gap-6">
      <header className="w-full max-w-5xl flex justify-between items-center">
        <h1 className="text-2xl font-bold">Blackjack</h1>
        <div className="rounded-lg bg-card px-3 py-2 border border-white/10">
          Balance: <span className="font-semibold">${((me?.balance_cents ?? 0)/100).toFixed(2)}</span>
        </div>
      </header>

      <div className="w-full max-w-5xl grid lg:grid-cols-[2fr_1fr] gap-6">
        <div className="rounded-2xl bg-card border border-white/10 p-4 shadow-glow">
          <div className="text-white/70 text-sm mb-2">Dealer</div>
          <div className="flex gap-2 mb-6">
            {round?.dealer_hand.cards.map((c, i) => (
              <Card key={i} rank={c.r} suit={c.s} flipped={false} />
            ))}
          </div>

          <div className="text-white/70 text-sm mb-2">Player</div>
          <div className="flex gap-2">
            {round?.player_hand.cards.map((c, i) => (
              <Card key={i} rank={c.r} suit={c.s} flipped={false} />
            ))}
          </div>

          <AnimatePresence>
            {msg && (
              <motion.div initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} exit={{opacity:0,y:8}} className="mt-4 text-accent">
                {msg}
              </motion.div>
            )}
          </AnimatePresence>

          <div className="mt-6 flex flex-wrap gap-2">
            <Button onClick={() => doAction("hit")}    className="disabled:opacity-50" disabled={!canAct}>Hit</Button>
            <Button onClick={() => doAction("stand")}  className="disabled:opacity-50" disabled={!canAct}>Stand</Button>
            <Button onClick={() => doAction("double")} className="disabled:opacity-50" disabled={!canAct}>Double</Button>
            <Button onClick={() => doAction("surrender")} className="disabled:opacity-50" disabled={!canAct}>Surrender</Button>
            {!round && <Button onClick={start}>Deal</Button>}
            {round?.status === "settled" && <Button onClick={() => { setRound(null); setMsg(null); }}>New Hand</Button>}
          </div>
        </div>

        <div className="rounded-2xl bg-card border border-white/10 p-4 shadow-glow">
          <div className="text-white/70 text-sm mb-2">Bet Controls</div>
          <ChipSelector onChange={setBet} />
          {!round && <Button className="w-full mt-4" onClick={start}>Place Bet & Deal</Button>}
        </div>
      </div>
    </div>
  );
}
