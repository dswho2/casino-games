import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import Card from "../../components/Card";
import Button from "../../components/Button";
import ChipSelector from "../../components/ChipSelector";
import ChipStack from "../../components/ChipStack";
import { amountCentsToDenoms } from "../../components/chips";
import { motion, AnimatePresence } from "framer-motion";
import { useAuthStore } from "../../store/auth";

type Hand = { cards: { r: string, s: "S"|"H"|"D"|"C" }[], value: number, soft: boolean };
type Round = {
  id: number; status: string; bet_cents: number;
  dealer_hand: Hand; player_hand: Hand;
  player_hands?: Hand[]; active_index?: number;
  outcome?: string; payout_cents?: number; balance_cents: number;
  shoe_reshuffled?: boolean;
};

export default function BlackjackTable() {
  const me = useAuthStore(s => s.me);
  const fetchMe = useAuthStore(s => s.fetchMe);
  const setMe = useAuthStore(s => s.setMe);
  const [round, setRound] = useState<Round|null>(null);
  const [bet, setBet] = useState(500);
  const [msg, setMsg] = useState<string | null>(null);
  const [betError, setBetError] = useState<string | null>(null);
  const [flipMap, setFlipMap] = useState<Record<string, boolean>>({});
  const [playerPulse, setPlayerPulse] = useState(false);
  const [dealerPulse, setDealerPulse] = useState(false);
  const prevRound = useRef<Round | null>(null);
  const [dealerRevealCount, setDealerRevealCount] = useState(1);
  const dealerTimers = useRef<number[]>([]);
  const flippedKeys = useRef<Set<string>>(new Set());
  const potRef = useRef<HTMLDivElement | null>(null);
  const balanceChipRef = useRef<HTMLDivElement | null>(null);
  const [flyingChips, setFlyingChips] = useState<{ id:number; x:number; y:number; dx:number; dy:number; delay:number; value:number }[]>([]);
  const [displayBalance, setDisplayBalance] = useState<number>(me?.balance_cents ?? 0);
  const [showShuffle, setShowShuffle] = useState(false);
  const naturalSeen = useRef<Set<string>>(new Set());
  const [naturalPulse, setNaturalPulse] = useState<Record<number, boolean>>({});
  const autoStood = useRef<Set<string>>(new Set());

  useEffect(() => { fetchMe(); }, [fetchMe]);

  // Animate balance number when store balance changes
  useEffect(() => {
    const target = me?.balance_cents ?? 0;
    let raf = 0;
    const start = performance.now();
    const from = displayBalance;
    const duration = 600;
    function tick(now: number){
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const value = Math.round(from + (target - from) * eased);
      setDisplayBalance(value);
      if (t < 1) raf = requestAnimationFrame(tick);
    }
    if (from !== target) raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [me?.balance_cents]);

  // Reset flip state on new round id
  useEffect(() => {
    flippedKeys.current.clear();
    setFlipMap({});
    setDealerRevealCount(1);
    naturalSeen.current.clear();
    setNaturalPulse({});
    autoStood.current.clear();
    if (round?.shoe_reshuffled) {
      setShowShuffle(true);
      const t = setTimeout(() => setShowShuffle(false), 1400);
      return () => clearTimeout(t);
    }
  }, [round?.id]);

  function triggerFlip(key: string, duration = 350) {
    if (flippedKeys.current.has(key)) return;
    flippedKeys.current.add(key);
    setFlipMap(prev => ({ ...prev, [key]: true }));
    window.setTimeout(() => setFlipMap(prev => ({ ...prev, [key]: false })), duration);
  }

  async function start() {
    if ((me?.balance_cents ?? 0) < bet) { setBetError("Not enough funds"); return; }
    setBetError(null);
    const r = await api<Round>(`/blackjack/start?bet_cents=${bet}`, { method:"POST" });
    setRound(r);
    setMsg(r.outcome ? formatResult(r.outcome) : null);
    // Only animate payout when the round is already settled
    if (r.status === 'settled' && (r.payout_cents ?? 0) > 0) {
      setTimeout(() => launchPayoutChips(r.payout_cents ?? 0), 50);
    }
    if (me) setMe({ ...me, balance_cents: r.balance_cents });
    fetchMe();
  }

  async function doAction(action: "hit"|"stand"|"double"|"split") {
    if (!round) return;
    if (action === "stand") { setPlayerPulse(true); setTimeout(() => setPlayerPulse(false), 250); }
    const r = await api<Round>(`/blackjack/action?session_id=${round.id}&action=${action}`, { method:"POST" });
    setRound(r); setMsg(r.outcome ? formatResult(r.outcome) : null);
    // Animate payout when round settles at the end
    if (r.status === 'settled' && (r.payout_cents ?? 0) > 0) {
      launchPayoutChips(r.payout_cents ?? 0);
    }
    if (me) setMe({ ...me, balance_cents: r.balance_cents });
    fetchMe();
  }

  const canAct = round && round.status === "in_progress" && !round.outcome;

  // Player new-card flip and split flips (only flip new cards)
  useEffect(() => {
    const prev = prevRound.current;
    if (round && prev) {
      const prevHands = prev.player_hands ?? [prev.player_hand];
      const nowHands = round.player_hands ?? [round.player_hand];
      const active = round.active_index ?? 0;
      if (nowHands.length > prevHands.length) {
        nowHands.forEach((h, hi) => { if (h.cards.length >= 2) triggerFlip(`p-${hi}-1`); });
      } else {
        const prevActive = prev.active_index ?? 0;
        const prevLen = (prevHands[active] || prevHands[prevActive] || prevHands[0]).cards.length;
        const nowLen = (nowHands[active] || nowHands[0]).cards.length;
        if (nowLen > prevLen) { for (let i = prevLen; i < nowLen; i++) triggerFlip(`p-${active}-${i}`); }
      }
    }
  }, [round]);

  // Track previous round snapshot
  useEffect(() => { prevRound.current = round; }, [round]);

  // Dealer reveal sequence with slight pauses for drama
  useEffect(() => {
    dealerTimers.current.forEach(t => clearTimeout(t));
    dealerTimers.current = [];
    if (!round) { setDealerRevealCount(1); return; }
    if (round.status === "in_progress") { setDealerRevealCount(1); return; }
    const total = round.dealer_hand.cards.length;
    setDealerRevealCount(1);
    setDealerPulse(true); setTimeout(() => setDealerPulse(false), 250);
    for (let i = 2; i <= total; i++) {
      const t = window.setTimeout(() => { setDealerRevealCount(i); triggerFlip(`d-${i-1}`); }, (i - 1) * 450);
      dealerTimers.current.push(t as unknown as number);
    }
  }, [round?.id, round?.status, round?.dealer_hand.cards.length]);

  // Cleanup timers on unmount
  useEffect(() => () => { dealerTimers.current.forEach(t => clearTimeout(t)); dealerTimers.current = []; }, []);

  // Natural pulse detection for each hand (2-card 21)
  useEffect(() => {
    if (!round) return;
    const nowHands = round.player_hands ?? [round.player_hand];
    nowHands.forEach((h, hi) => {
      if (isNatural(h)) {
        const key = `${round.id}:${hi}`;
        if (!naturalSeen.current.has(key)) {
          naturalSeen.current.add(key);
          setNaturalPulse(prev => ({ ...prev, [hi]: true }));
          window.setTimeout(() => setNaturalPulse(prev => ({ ...prev, [hi]: false })), 480);
        }
      }
    });
  }, [round]);

  function isNatural(h?: Hand): boolean {
    if (!h || h.cards.length !== 2) return false;
    const ranks = h.cards.map(c => c.r);
    const hasAce = ranks.includes('A');
    const hasTenish = ranks.some(r => r === '10' || r === 'J' || r === 'Q' || r === 'K');
    return hasAce && hasTenish;
  }

  // Auto-skip player input on natural hands while round is in progress
  useEffect(() => {
    if (!round || round.status !== 'in_progress') return;
    const idx = round.active_index ?? 0;
    const cur = (round.player_hands ?? [round.player_hand])[idx];
    if (!cur) return;
    if (isNatural(cur)) {
      const key = `${round.id}:${idx}`;
      if (!autoStood.current.has(key)) {
        autoStood.current.add(key);
        // Skip this hand by standing immediately; payout happens at end
        doAction('stand');
      }
    }
  }, [round?.id, round?.status, round?.active_index, round?.player_hands, round?.player_hand]);

  function formatTotal(h?: Hand) {
    if (!h) return "";
    if (h.soft && h.value > 11) return `${h.value - 10}/${h.value}`;
    return `${h.value}`;
  }

  function formatResult(outcome: string) {
    if (outcome === 'blackjack') return 'Round Result: Natural';
    const pretty = outcome.charAt(0).toUpperCase() + outcome.slice(1);
    return `Round Result: ${pretty}`;
  }

  function valueOfRank(r: string): number {
    if (r === 'A') return 11;
    if (r === 'K' || r === 'Q' || r === 'J' || r === '10') return 10;
    return Number(r);
  }

  function visibleDealerTotal(): string {
    if (!round || round.dealer_hand.cards.length === 0) return '';
    const up = round.dealer_hand.cards[0];
    return String(valueOfRank(up.r));
  }

  function resultDetail(): string {
    if (!round) return '';
    const dv = round.dealer_hand.value;
    const pvals = (round.player_hands ?? [round.player_hand]).map(h => h.value);
    if (round.outcome === 'blackjack') return 'Natural';
    if (pvals.every(v => v > 21)) return 'Player busted';
    if (dv > 21) return 'Dealer busted';
    if (round.outcome === 'push') return 'Push';
    if (round.outcome === 'win') return 'Player beats dealer';
    if (round.outcome === 'lose') return 'Dealer beats player';
    if (round.outcome === 'mixed') return 'Mixed results';
    return (round.outcome ?? '').toString();
  }

  const hands = round ? (round.player_hands ?? [round.player_hand]) : [];
  const active = round?.active_index ?? 0;
  // Lock pot to the server-accepted bet only while a round is in progress.
  const inProgress = !!(round && round.status === "in_progress" && !round.outcome);
  const potCents = inProgress ? (round?.bet_cents ?? bet) : bet;

  function launchPayoutChips(payoutCents: number){
    if (!potRef.current || !balanceChipRef.current) return;
    const s = potRef.current.getBoundingClientRect();
    const e = balanceChipRef.current.getBoundingClientRect();
    const chipSize = 24; // px (matches Chip size below)
    const startX = s.left + s.width/2 - chipSize/2;
    const startY = s.top + s.height/2 - chipSize/2;
    const endX = e.left + e.width/2 - chipSize/2;
    const endY = e.top + e.height/2 - chipSize/2;
    const dx = endX - startX;
    const dy = endY - startY;
    const chipVals = payoutToChips(payoutCents);
    const animMs = 500; // flight duration per chip (kept in sync with transition below)
    const interDelay = 80; // stagger between chips
    const chips = chipVals.map((val, i) => ({
      id: Date.now() + i,
      x: startX,
      y: startY,
      dx,
      dy,
      delay: i * interDelay,
      value: val,
    }));
    setFlyingChips(chips);
    // Clear shortly after the last chip arrives (minimal linger)
    const lastDelay = chips.length ? chips[chips.length - 1].delay : 0;
    const clearAfter = lastDelay + animMs + 120; // small buffer
    setTimeout(() => setFlyingChips([]), clearAfter);
  }

  function payoutToChips(amountCents: number): number[] {
    return amountCentsToDenoms(amountCents, 12);
  }

  return (
    <div className="flex flex-col items-center gap-6">
      {/* Shuffle banner */}
      <AnimatePresence>
        {showShuffle && (
          <motion.div
            key="shuffle-banner"
            initial={{ y: -12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -12, opacity: 0 }}
            transition={{ duration: 0.22 }}
            className="fixed top-16 left-1/2 -translate-x-1/2 z-50 rounded-lg bg-yellow-500/20 border border-yellow-400/40 text-yellow-200 px-3 py-1 text-sm shadow-glow"
          >
            Deck Reshuffled
          </motion.div>
        )}
      </AnimatePresence>
      <header className="w-full max-w-5xl flex justify-between items-center">
        <h1 className="text-2xl font-bold">Blackjack</h1>
        <div className="rounded-lg bg-card px-2 py-2 border border-white/10 flex items-center gap-2">
          <div ref={balanceChipRef} className="relative" style={{ top: 2, left: -4 }}>
            <ChipStack amountCents={500} chipSize={32} className="overflow-visible"/>
          </div>
          <span>Balance:</span>
          <span className="font-semibold">${((displayBalance ?? 0)/100).toFixed(2)}</span>
        </div>
      </header>

      <div className="w-full max-w-5xl grid lg:grid-cols-[2fr_1fr] gap-6">
        <div className="rounded-2xl bg-card border border-white/10 p-4 shadow-glow relative">
          <div className="absolute right-4 top-4 text-xs text-white/70">Pot: ${(potCents/100).toFixed(2)}</div>
          <div ref={potRef} className="absolute right-10 top-12 z-10">
            <ChipStack amountCents={potCents} chipSize={64} className="overflow-visible"/>
          </div>
          <div className="text-white/70 text-sm mb-2">Dealer {round && (round.status === "settled" ? `· ${formatTotal(round.dealer_hand)}` : `· ${visibleDealerTotal()}`)}</div>
          <motion.div animate={{ scale: dealerPulse ? 0.98 : 1 }} className="flex gap-2 mb-6">
            {round ? (
              round.status === "in_progress" && !round.outcome ? (
                <>
                  {round.dealer_hand.cards[0] && (
                    <motion.div layout initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 22 }}>
                      <Card rank={round.dealer_hand.cards[0].r} suit={round.dealer_hand.cards[0].s} flipped={!!flipMap["d-0"]} />
                    </motion.div>
                  )}
                  {round.dealer_hand.cards[1] && (
                    <motion.div layout initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 22 }}>
                      <Card rank={""} suit={"S"} faceDown flipped={false} />
                    </motion.div>
                  )}
                </>
              ) : (
                round.dealer_hand.cards.slice(0, dealerRevealCount).map((c, i) => (
                  <motion.div key={`d-${i}-${c.r}${c.s}`} layout initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 22 }}>
                    <Card rank={c.r} suit={c.s} flipped={!!flipMap[`d-${i}`]} />
                  </motion.div>
                ))
              )
            ) : null}
          </motion.div>

          <div className="text-white/70 text-sm mb-2">Player</div>
          <div className="flex flex-wrap gap-4">
            {hands.map((h, hi) => (
              <motion.div
                key={`hand-${hi}`}
                className={`relative overflow-visible rounded-xl p-2 border border-white/10 ${hi === active ? 'ring-1 ring-accent/50' : ''} ${naturalPulse[hi] ? 'ring-2 ring-yellow-400' : ''}`}
                animate={{ scale: naturalPulse[hi] ? 0.96 : 1 }}
                transition={{ duration: 0.26 }}
              >
                <AnimatePresence initial={false}>
                  {naturalPulse[hi] && (
                    <motion.div
                      key="burst"
                      className="absolute -inset-2 rounded-2xl pointer-events-none"
                      style={{
                        background: 'radial-gradient(ellipse at center, rgba(255,215,0,0.45) 0%, rgba(255,215,0,0.18) 40%, rgba(255,215,0,0) 70%)',
                        filter: 'blur(6px)',
                        zIndex: -1,
                      }}
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 0.7, scale: 1.06 }}
                      exit={{ opacity: 0, scale: 1.12 }}
                      transition={{ duration: 0.36 }}
                    />
                  )}
                </AnimatePresence>
                <div className="text-white/60 text-xs mb-1">{hi === active ? 'Active' : `Hand ${hi+1}`} · {formatTotal(h)}</div>
                <motion.div animate={{ scale: playerPulse && hi === active ? 0.98 : 1 }} className="flex gap-2">
                  {h.cards.map((c, i) => (
                    <motion.div key={`p-${hi}-${i}-${c.r}${c.s}`} layout initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 22 }}>
                      <Card rank={c.r} suit={c.s} flipped={!!flipMap[`p-${hi}-${i}`]} />
                    </motion.div>
                  ))}
                </motion.div>
              </motion.div>
            ))}
          </div>

          

          <div className="mt-6 flex flex-wrap gap-2">
            {(() => {
              const cur = hands[active];
              const isFirstMove = !!(round && round.status === "in_progress" && cur && cur.cards.length === 2);
              const isActiveNatural = !!(round && round.status === "in_progress" && isNatural(cur));
              const canPlay = !!(canAct && !isActiveNatural);
              const canDouble = !!(isFirstMove && !isActiveNatural);
              const canSplit = !!(isFirstMove && !isActiveNatural && cur && ((valueOfRank(cur.cards[0].r) === 10 && valueOfRank(cur.cards[1].r) === 10) || cur.cards[0].r === cur.cards[1].r) && (me?.balance_cents ?? 0) >= (round?.bet_cents ?? 0));
              return (
                <>
                  <Button onClick={() => doAction("hit")}    className="disabled:opacity-50" disabled={!canPlay}>Hit</Button>
                  <Button onClick={() => doAction("stand")}  className="disabled:opacity-50" disabled={!canPlay}>Stand</Button>
                  <Button onClick={() => doAction("double")} className="disabled:opacity-50" disabled={!canDouble}>Double</Button>
                  <Button onClick={() => doAction("split")}  className="disabled:opacity-50" disabled={!canSplit}>Split</Button>
                </>
              );
            })()}
          </div>

          {round?.status === "settled" && dealerRevealCount >= (round?.dealer_hand.cards.length ?? 0) && (
            <div className="mt-6 rounded-xl bg-black/20 border border-white/10 p-4">
              <div className="text-2xl font-extrabold text-green-400 mb-3">
                {(() => {
                  const payout = (round.payout_cents ?? 0) / 100;
                  if (payout > 0) return `Payout +$${payout.toFixed(2)}`;
                  return "No Payout";
                })()}
              </div>
              <div className="font-semibold mb-2">Round Summary</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>Bet:</div><div className="text-right">${(round.bet_cents/100).toFixed(2)}</div>
                <div>Player Total:</div><div className="text-right">{hands.map(h => h.value).join(', ')}</div>
                <div>Dealer Total:</div><div className="text-right">{round.dealer_hand.value}</div>
                <div>Result:</div><div className="text-right">{resultDetail()}</div>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-2xl bg-card border border-white/10 p-4 shadow-glow">
          <div className="text-white/70 text-sm mb-2">Bet Controls</div>
          <ChipSelector onChange={(c)=>{ setBet(c); setBetError(null); }} />
          {(!round || round.status === "settled") && (
            <>
              <Button className="w-full mt-4" onClick={() => { setMsg(null); start(); }}>
                Place Bet & Deal
              </Button>
              {betError && <div className="text-danger text-sm mt-2">{betError}</div>}
            </>
          )}
        </div>
      </div>
      {/* Chip flight overlay */}
      <div className="pointer-events-none fixed inset-0 z-50">
        <AnimatePresence initial={false}>
          {flyingChips.map(ch => (
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
