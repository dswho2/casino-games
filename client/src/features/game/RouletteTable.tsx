import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { api } from "../../api/client";
import Button from "../../components/Button";
import ChipStack from "../../components/ChipStack";
import { chipColorFor, chipSrc, chipImageHeight } from "../../components/chips";
import { ChipFlightOverlay, buildChipFlights, getNavBalanceTarget } from "../../components/ChipFlight";
// ChipSelector removed in favor of draggable chips
import { useAuthStore } from "../../store/auth";

type Bet = { type: "straight" | "color" | "even" | "odd" | "low" | "high" | "dozen" | "column" | "split" | "corner"; target: string; amount_cents: number };

type WheelConfig = { pockets: string[]; step: number; assetOffsetRad: number };

type StartResp = { targetNumber: string; commitHash: string; spinId: number; wheelConfig: WheelConfig };
type SettleResp = { payouts: { selection: string; amount_wagered: number; multiple: number; win_amount: number }[]; newBalance: number; seed: string };

// European single-zero layout (clockwise from top 0)
const EURO_POCKETS = [
  "0",
  "32","15","19","4","21","2","25","17","34","6","27","13","36","11","30","8","23",
  "10","5","24","16","33","1","20","14","31","9","22","18","29","7","28","12","35","3","26",
];
const TAU = Math.PI * 2;
const STEP = TAU / EURO_POCKETS.length;
const WHEEL_ASSET_OFFSET = -Math.PI / 2; // radians; 0 pocket at top (rotate -90°)
let POCKETS_CLOCKWISE = true; // runtime-overridable based on server config
const WHEEL_SIZE = 420; // px, visual size of the wheel image
const BALL_RADIUS_RATIO = 0.3; // as fraction of wheel size; adjust to move ball inward/outward
const BALL_DRAW_OFFSET_RAD = -Math.PI / 2; // visual mapping offset to match highlight orientation
const GLOW_CENTER_DEG = 180; // our gradient's wedge is centered at 180deg baseline

type Phase = "betting" | "spinning" | "settling";

export default function RouletteTable() {
  const me = useAuthStore(s => s.me);
  const setMe = useAuthStore(s => s.setMe);
  const fetchMe = useAuthStore(s => s.fetchMe);
  const [phase, setPhase] = useState<Phase>("betting");
  const [bets, setBets] = useState<Bet[]>([]);
  // Amount selection handled via draggable chips on the board
  const [error, setError] = useState<string | null>(null);

  // Round data
  const [spinId, setSpinId] = useState<number | null>(null);
  const [commitHash, setCommitHash] = useState<string | null>(null);
  const [seed, setSeed] = useState<string | null>(null);
  const [targetNumber, setTargetNumber] = useState<string | null>(null);
  const [wheelCfg, setWheelCfg] = useState<WheelConfig | null>(null);
  const [payouts, setPayouts] = useState<SettleResp["payouts"]>([]);

  const totalWager = useMemo(() => bets.reduce((s, b) => s + b.amount_cents, 0), [bets]);
  // Max potential varies by bet type; this UI does not show it anymore.
  const maxPotential = totalWager; // placeholder; not displayed in UI

  function addBet(b: Bet){
    if (phase !== "betting") return;
    setBets(prev => [...prev, b]);
  }
  function clearBets(){ if (phase === "betting") setBets([]); }

  // Animation refs
  const wheelRef = useRef<HTMLDivElement>(null);
  const ballRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const hudTextRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);
  const bounceRef = useRef<number>(0);
  const lastTickAtRef = useRef<number>(0);
  const settleRequestedRef = useRef<boolean>(false);
  const [landed, setLanded] = useState<boolean>(false);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const dragImgRef = useRef<HTMLImageElement | null>(null);
  const zoneRefs = useRef<Record<string, HTMLElement | null>>({});
  const [flyingChips, setFlyingChips] = useState<{ id:number; x:number; y:number; dx:number; dy:number; delay:number; value:number }[]>([]);

  // Audio: quiet tick using WebAudio oscillator
  const audioCtxRef = useRef<AudioContext | null>(null);
  function tickSound(){
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      const ac = audioCtxRef.current!;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "square"; osc.frequency.value = 520; // lower pitch
      gain.gain.value = 0.012; // quieter
      osc.connect(gain).connect(ac.destination);
      osc.start();
      osc.stop(ac.currentTime + 0.02);
    } catch {}
  }

  // Deterministic spin animation
  function runSpinAnimation(targetNum: string, cfg: WheelConfig, spinIdForThisSpin?: number){
    const pockets = cfg.pockets?.length ? cfg.pockets : EURO_POCKETS;
    const step = cfg.step || STEP;
    const assetOffset = (cfg.assetOffsetRad ?? WHEEL_ASSET_OFFSET);
    const cw = (cfg as any).clockwise;
    if (typeof cw === 'boolean') POCKETS_CLOCKWISE = cw;
    const targetIdx = pockets.indexOf(targetNum);
    const signedIdx = targetIdx >= 0 ? targetIdx : 0;
    const targetAngle = (POCKETS_CLOCKWISE ? signedIdx : -signedIdx) * step;

    const wheelStart = Math.random() * TAU;
    const wheelRevs = 6 + Math.floor(Math.random() * 3); // 6..8 (faster overall)
    const duration = 12 * 1000; // total spin time

    // Choose a landing moment as a fraction of the total animation time
    const landT = 0.55; // ball lands first while wheel keeps rotating

    // Global wheel easing: starts fast, smoothly decelerates without re-acceleration
    const easeWheel = (u: number) => 1 - Math.pow(1 - u, 3.8); // even faster opening burst, smooth decel

    // Compute absolute angles including asset offset
    const startAbs = wheelStart + assetOffset;
    // Final orientation so the winning pocket ends at the top; keep forward direction and add spins
    let wheelTargetAbs = -targetAngle;
    while (wheelTargetAbs <= startAbs) wheelTargetAbs += TAU;
    wheelTargetAbs += wheelRevs * TAU; // ensure several full spins overall

    // Precompute wheel angle at landing time based on global easing
    const easeWheelAtLand = easeWheel(landT);
    const wheelAngleAtLand = startAbs + (wheelTargetAbs - startAbs) * easeWheelAtLand;
    const landingAbsoluteAngle = wheelAngleAtLand + targetAngle; // where the ball will be at landT

    // Opposite-direction ball start so it moves backwards into the landing pocket
    const ballTurns = 6 + Math.floor(Math.random() * 4); // 6..9 (less orbiting)
    const ballStart = landingAbsoluteAngle + (ballTurns + Math.random()) * TAU; // start ahead so it moves backward

    const start = performance.now();
    let lastTickK = -1;
    settleRequestedRef.current = false;
    setLanded(false);

    // Ensure ball is visible for the new spin
    if (ballRef.current) { ballRef.current.style.opacity = '1'; }
    cancelAnimationFrame(rafRef.current);
    const loop = (now: number) => {
      const t = Math.min(1, (now - start) / duration);

      // Wheel: single global deceleration curve (fast at start, no late speed-up)
      const wheelEase = easeWheel(t);
      const wheelAngle = startAbs + (wheelTargetAbs - startAbs) * wheelEase;

      // Ball motion: free until landing, then lock to pocket and move with wheel
      let ballAngle: number;
      if (t <= landT) {
        const tBall = t / landT; // 0..1
        // Ball decelerates from the start (no acceleration): ease-out
        const ballEase = 1 - Math.pow(1 - Math.min(1, tBall), 2.4);
        ballAngle = ballStart + (landingAbsoluteAngle - ballStart) * ballEase;

        // Tick while passing pocket separators (pre-landing only)
        const rel = (ballAngle - wheelAngle) / step;
        const k = Math.floor(rel);
        if (k !== lastTickK) {
          const nowMs = performance.now();
          // slower ticks when fast
          const minGap = 40 + (1 - t / landT) * 120;
          if (nowMs - lastTickAtRef.current >= minGap) {
            lastTickAtRef.current = nowMs;
            lastTickK = k;
            tickSound();
            bounceRef.current = Math.min(1.2, bounceRef.current + 0.45);
          }
        }
      } else {
        // After landing, ball locks to winning pocket relative to the wheel
        ballAngle = wheelAngle + targetAngle;
      }

      // Decay post-landing bounce
      bounceRef.current *= 0.92;

      // Blur: start unblurring earlier for clearer mid/late spin
      const blur = (1 - Math.min(1, t * 1.85)) * 3.5; // px
      if (wheelRef.current) {
        const deg = (wheelAngle * 180) / Math.PI;
        wheelRef.current.style.transform = `rotate(${deg}deg)`;
        wheelRef.current.style.filter = `blur(${blur.toFixed(2)}px)`;
      }
      if (ballRef.current) {
        const deg = (ballAngle * 180) / Math.PI;
        const baseRadius = WHEEL_SIZE * BALL_RADIUS_RATIO; // starting radius
        const landingRatio = 0.6; // radius factor at landing (closer in than before)
        const finalRatio = 0.55; // end at ~55% of starting radius (further inward)
        let radiusRatio: number;
        if (t <= landT) {
          const t1 = t / landT;
          // Ease the radius inward pre-landing (more movement near landing)
          const easeRad = 1 - Math.pow(1 - t1, 2.2);
          radiusRatio = 1 - (1 - landingRatio) * easeRad;
          const bounceInward = bounceRef.current * 6; // inward nudge on pocket hits
          const spiralRadius = baseRadius * radiusRatio - bounceInward;
          const a = ballAngle + BALL_DRAW_OFFSET_RAD; // compensate visual 90° mapping
          const x = Math.cos(a) * spiralRadius;
          const y = Math.sin(a) * spiralRadius;
          ballRef.current.style.transform = `translate(${x}px, ${y}px) rotate(${deg}deg)`;
        } else {
          // Continue moving inward after landing until the wheel stops
          const post = (t - landT) / (1 - landT); // 0..1
          const easePost = 1 - Math.pow(1 - post, 2.0);
          radiusRatio = landingRatio + (finalRatio - landingRatio) * easePost;
          const radius = baseRadius * radiusRatio;
          const a = ballAngle + BALL_DRAW_OFFSET_RAD;
          const x = Math.cos(a) * radius;
          const y = Math.sin(a) * radius;
          ballRef.current.style.transform = `translate(${x}px, ${y}px) rotate(${deg}deg)`;
        }
      }
      if (glowRef.current) {
        // Align highlight wedge to pocket center (wheel rotation + pocket angle), minus wedge's native 180deg offset
        const deg = ((wheelAngle + targetAngle) * 180) / Math.PI - GLOW_CENTER_DEG;
        glowRef.current.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
        // Show glow as soon as the ball lands
        glowRef.current.style.opacity = t >= landT ? "1" : "0";
      }
      if (hudTextRef.current) {
        hudTextRef.current.textContent = t < landT ? `Spinning…` : `Result: ${targetNum}`;
      }

      // Kick off settle as soon as the ball lands (once)
      if (t >= landT && !settleRequestedRef.current) {
        settleRequestedRef.current = true;
        setLanded(true);
        onSpinComplete(spinIdForThisSpin ?? spinId);
      }

      if (t < 1) rafRef.current = requestAnimationFrame(loop);
      else {
        cancelAnimationFrame(rafRef.current);
        // Fallback: if landing callback didn’t fire, settle now
        if (!settleRequestedRef.current) {
          settleRequestedRef.current = true;
          setLanded(true);
          onSpinComplete(spinIdForThisSpin ?? spinId);
        }
      }
    };
    rafRef.current = requestAnimationFrame(loop);
  }

  async function onSpinComplete(explicitSpinId?: number | null){
    try {
      const id = explicitSpinId ?? spinId;
      if (!id) return;
      const res = await api<SettleResp>(`/roulette/settle`, { method: "POST", body: JSON.stringify({ spinId: id }) });
      setSeed(res.seed);
      setPayouts(res.payouts);
      if (me) setMe({ ...me, balance_cents: res.newBalance });
      setPhase("settling");
      // Launch chip flights from winning zones (based on original bets)
      try {
        const targetEl = getNavBalanceTarget();
        if (targetEl) {
          const allFlights: { id:number; x:number; y:number; dx:number; dy:number; delay:number; value:number }[] = [];
          let baseDelay = 0;
          for (const p of (res.payouts || [])) {
            if (!p || (p.win_amount || 0) <= 0) continue;
            const [ptype, praw = ''] = String(p.selection || '').split(':', 2);
            let key = `${ptype}:${praw}`;
            if (ptype === 'even' || ptype === 'odd' || ptype === 'low' || ptype === 'high') key = `${ptype}:${praw.toUpperCase()}`;
            const el = zoneRefs.current[key];
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            const built = buildChipFlights(p.win_amount, rect, targetEl, { chipSize: 24, interDelay: 80, baseDelay, maxChips: 12 });
            allFlights.push(...built.flights);
            baseDelay += built.totalDelay;
          }
          setFlyingChips(allFlights);
          const clearAfter = baseDelay + 500 + 140;
          setTimeout(() => setFlyingChips([]), clearAfter);
        }
      } catch {}
    } catch (e: any) {
      setError(e?.message || "Failed to settle");
      setPhase("betting");
    }
  }

  async function submitBets(){
    setError(null);
    if (phase !== "betting") return;
    if (bets.length === 0) { setError("Place at least one bet"); return; }
    try {
      setPhase("spinning");
      // Backend now supports all outside bet types; submit as-is
      const body = { tableId: "main", bets: bets.map(b => ({ type: b.type, target: b.target, amount_cents: b.amount_cents })) };
      const res = await api<StartResp>(`/roulette/start`, { method: "POST", body: JSON.stringify(body) });
      setCommitHash(res.commitHash);
      setSpinId(res.spinId);
      setTargetNumber(res.targetNumber);
      setWheelCfg(res.wheelConfig);
      // Reflect the debited balance immediately
      try { await fetchMe(); } catch {}
      // Fire the animation deterministically; pass spin id to avoid stale closure
      runSpinAnimation(res.targetNumber, res.wheelConfig || { pockets: EURO_POCKETS, step: STEP, assetOffsetRad: WHEEL_ASSET_OFFSET }, res.spinId);
    } catch (e: any) {
      setError(e?.message || "Failed to start roulette round");
      setPhase("betting");
    }
  }

  function nextRound(){
    // Stop any running animation and reset visuals
    cancelAnimationFrame(rafRef.current);
    settleRequestedRef.current = false;
    bounceRef.current = 0;
    lastTickAtRef.current = 0;
    // Fade out ball and glow immediately
    if (ballRef.current) { ballRef.current.style.opacity = '0'; }
    if (glowRef.current) { glowRef.current.style.opacity = '0'; }
    // Smoothly rotate wheel back to baseline (0°) instead of snapping
    (function smoothReset(){
      const el = wheelRef.current;
      if (!el) return;
      // Parse current rotation in degrees
      const m = /rotate\(([-+0-9\.]+)deg\)/.exec(el.style.transform || '');
      let from = m ? parseFloat(m[1]) : 0;
      if (!isFinite(from)) from = 0;
      const to = 0; // baseline orientation used by the asset (0 on top)
      // Shortest angular delta in [-180,180]
      let delta = ((to - from + 540) % 360) - 180;
      const start = performance.now();
      const duration = 600;
      const ease = (u: number) => 1 - Math.pow(1 - u, 3); // easeOutCubic
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        const deg = from + delta * ease(t);
        el.style.transform = `rotate(${deg}deg)`;
        el.style.filter = '';
        if (t < 1) rafRef.current = requestAnimationFrame(tick);
        else {
          // Ensure final exact baseline state
          el.style.transform = '';
          el.style.filter = '';
        }
      };
      rafRef.current = requestAnimationFrame(tick);
    })();
    // Reset ball transform after rotation completes
    if (ballRef.current) { ballRef.current.style.transform = ''; }
    if (hudTextRef.current) { hudTextRef.current.textContent = 'Place your bets'; }
    if (hudTextRef.current) { hudTextRef.current.textContent = 'Place your bets'; }
    setLanded(false);

    // Reset round state
    setPhase("betting");
    setBets([]);
    setSpinId(null); setCommitHash(null); setSeed(null); setTargetNumber(null);
    setPayouts([]);
  }

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  // UI helpers
  const canSubmit = phase === "betting" && bets.length > 0 && totalWager > 0;
  const targetColor = useMemo(() => {
    if (!targetNumber) return null;
    if (targetNumber === '0') return 'G';
    const n = Number(targetNumber);
    const redNums = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
    return redNums.has(n) ? 'R' : 'B';
  }, [targetNumber]);

  const totalPayoutCents = payouts.reduce((s, p) => s + (p.win_amount || 0), 0);
  const totalPayout = totalPayoutCents / 100;
  // Format server payout selection tokens into user-friendly labels
  function formatSelection(sel: string): string {
    const [type, raw = ''] = sel.split(":", 2);
    switch (type) {
      case 'straight': return raw || sel;
      case 'color': return raw === 'R' ? 'Red' : raw === 'B' ? 'Black' : sel;
      case 'even': return 'Even';
      case 'odd': return 'Odd';
      case 'low': return '1–18';
      case 'high': return '19–36';
      case 'dozen': return raw === '1' ? '1st 12' : raw === '2' ? '2nd 12' : raw === '3' ? '3rd 12' : sel;
      case 'column': return raw === '1' ? 'Column 1' : raw === '2' ? 'Column 2' : raw === '3' ? 'Column 3' : sel;
      default: return sel;
    }
  }
  // Potential winnings (returns) based on bet types. Returns include stake.
  const potentialReturnCents = useMemo(() => {
    const multipleFor = (b: Bet) => {
      switch (b.type) {
        case 'straight': return 36;       // 35:1 payout => 36x return
        case 'split': return 18;          // 17:1 => 18x return
        case 'corner': return 9;          // 8:1 => 9x return
        case 'dozen':
        case 'column': return 3;          // 2:1 => 3x return
        case 'color':
        case 'even':
        case 'odd':
        case 'low':
        case 'high': return 2;            // 1:1 => 2x return
        default: return 0;
      }
    };
    return bets.reduce((sum, b) => sum + b.amount_cents * multipleFor(b), 0);
  }, [bets]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(280px,520px)_1fr] gap-6">
      {/* Left: Wheel */}
      <div className="relative rounded-2xl bg-card/70 border border-white/10 p-4">
        <div className="text-lg font-semibold mb-3">Wheel</div>
        <div className="relative mx-auto" style={{ width: WHEEL_SIZE, height: WHEEL_SIZE }}>
          {/* Centered origin wrapper (fixed size to avoid 0x300 issue) */}
          <div className="absolute left-1/2 top-1/2 relative" style={{ transform: "translate(-50%, -50%)", width: WHEEL_SIZE, height: WHEEL_SIZE }}>
            <div ref={wheelRef} className="will-change-transform absolute inset-0" style={{ transformOrigin: '50% 50%' }}>
              <img src="/roulette/roulette_wheel.webp" alt="Roulette Wheel" width={WHEEL_SIZE} height={WHEEL_SIZE} draggable={false} style={{ width: WHEEL_SIZE, height: WHEEL_SIZE, display: 'block' }} onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
            </div>
            {/* Winner glow wedge: highlight the full number segment band with a gold glow */}
            <div ref={glowRef} className="pointer-events-none absolute left-1/2 top-1/2 will-change-transform" style={{ width: WHEEL_SIZE, height: WHEEL_SIZE, transform: 'translate(-50%, -50%)', opacity: 0 }}>
              <div className="absolute left-1/2 top-1/2" style={{ transform: 'translate(-50%, -50%)' }}>
                {(() => {
                  const sDeg = (wheelCfg?.step || STEP) * 180 / Math.PI; // degrees per pocket
                  const start = 180 - sDeg / 2;
                  const end = 180 + sDeg / 2;
                  // Fill only the winning segment's angular width
                  const bg = `conic-gradient(from 0deg, transparent 0deg, transparent ${start}deg, rgba(255, 215, 96, 0.55) ${start}deg, rgba(255, 215, 96, 0.55) ${end}deg, transparent ${end}deg, transparent 360deg)`;
                  // Restrict to the number ring band (inner..outer), leaving just that segment outlined
                  const R = WHEEL_SIZE / 2;
                  const innerR = Math.round(R * 0.28); // approximate inner boundary of number ring
                  const outerR = Math.round(R * 0.55); // near rim
                  const mask = `radial-gradient(circle, transparent ${innerR}px, #fff ${innerR}px, #fff ${outerR}px, transparent ${outerR}px)`;
                  return (
                    <div style={{ position:'relative', width: WHEEL_SIZE, height: WHEEL_SIZE, borderRadius: '50%', background: bg, WebkitMaskImage: mask, maskImage: mask, filter: 'drop-shadow(0 0 10px rgba(255,215,96,0.7)) drop-shadow(0 0 18px rgba(255, 205, 56, 0.6))' }} />
                  );
                })()}
              </div>
            </div>
            {/* Ball */}
            <div ref={ballRef} className="absolute left-1/2 top-1/2 will-change-transform" style={{ width: 10, height: 10, marginLeft: -5, marginTop: -5, borderRadius: 9999, background: '#fafafa', boxShadow: '0 0 6px rgba(255,255,255,0.7), 0 0 14px rgba(255,255,255,0.35)' }} />
          </div>
          {/* HUD */}
          <div className="absolute bottom-2 left-2 right-2 text-center text-sm text-white/80">
            <div ref={hudTextRef}>{phase === 'spinning' ? 'Spinning…' : phase === 'settling' ? (targetNumber ? `Result: ${targetNumber}` : '') : 'Place your bets'}</div>
          </div>
        </div>
      </div>

      {/* Right: Betting + Summary */}
      <div className="flex flex-col gap-4">
        {/* Bets panel */}
        <div className="rounded-2xl bg-card/70 border border-white/10 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-lg font-semibold">Place Your Bets</div>
            {phase === 'betting' && (
              <button onClick={clearBets} className="text-white/70 hover:text-white text-sm">Clear</button>
            )}
          </div>

          {/* Draggable chip rack */}
          <div className="mb-4 flex flex-wrap gap-3 items-center">
            {([1,5,10,25,100,500,1000,5000] as const).map(denom => (
              <div
                key={denom}
                role="button"
                draggable={phase==='betting'}
                onDragStart={(e) => {
                  const amt = String(denom*100);
                  e.dataTransfer.setData('text/plain', amt);
                  e.dataTransfer.effectAllowed='copy';
                  // Custom drag image: chip following the cursor
                  try {
                    const size = 44;
                    const img = new Image(size, chipImageHeight(size));
                    img.src = chipSrc(chipColorFor(denom));
                    img.style.position = 'absolute';
                    img.style.top = '-1000px';
                    img.style.left = '-1000px';
                    img.style.pointerEvents = 'none';
                    document.body.appendChild(img);
                    dragImgRef.current = img;
                    e.dataTransfer.setDragImage(img, Math.floor(size/2), Math.floor(chipImageHeight(size)/2));
                    // Hide OS cursor during drag
                    document.body.style.cursor = 'none';
                  } catch {}
                }}
                onDragEnd={() => { try { if (dragImgRef.current) { dragImgRef.current.remove(); dragImgRef.current = null; } } catch {} finally { try { document.body.style.cursor = ''; } catch {} } }}
                className="flex items-center gap-2 p-1 rounded hover:bg-white/5 active:scale-[0.98] cursor-grab"
                title={`Drag to bet $${denom}`}
              >
                <img src={chipSrc(chipColorFor(denom))} width={40} height={chipImageHeight(40)} alt={`$${denom} chip`} />
                <div className="text-white/80 text-sm">${denom}</div>
              </div>
            ))}
            <div className="ml-auto text-white/70 text-sm">Total wager: <span className="text-white font-semibold">${(totalWager/100).toFixed(2)}</span></div>
          </div>

          {/* Roulette betting layout */}
          {(() => {
            const redNums = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
            const placedMap = bets.reduce<Record<string, number>>((m, b) => { const k = `${b.type}:${b.target}`; m[k]=(m[k]||0)+b.amount_cents; return m; }, {});

            // Related numbers for hover zone (used to show secondary blue highlight)
            const numbersForHover = (key: string | null): Set<number> => {
              const set = new Set<number>();
              if (!key) return set;
              const [type, target] = key.split(":", 2);
              const addRange = (a:number,b:number) => { for(let n=a;n<=b;n++) set.add(n); };
              if (type === 'straight') {
                const n = parseInt(target, 10);
                if (n >= 1 && n <= 36) set.add(n);
                return set;
              }
              if (type === 'color') {
                for (let n=1;n<=36;n++) { if ((target==='R' && redNums.has(n)) || (target==='B' && !redNums.has(n))) set.add(n); }
                return set;
              }
              if (type === 'even') { for (let n=2;n<=36;n+=2) set.add(n); return set; }
              if (type === 'odd') { for (let n=1;n<=35;n+=2) set.add(n); return set; }
              if (type === 'low') { addRange(1,18); return set; }
              if (type === 'high') { addRange(19,36); return set; }
              if (type === 'dozen') {
                const dz = parseInt(target,10);
                if (dz===1) addRange(1,12); else if (dz===2) addRange(13,24); else if (dz===3) addRange(25,36);
                return set;
              }
              if (type === 'column') {
                const ci = parseInt(target,10); // 1..3
                for (let n=1;n<=36;n++) { if (n % 3 === ((ci%3)||0)) set.add(n); }
                // n%3==1 -> col1, 2->col2, 0->col3; our formula above uses (ci%3)||0 to map 3->0
                return set;
              }
              return set;
            };
            const related = numbersForHover(hoverKey);

            const Cell = ({ children, className, onDropZone, title, style, zoneKey }: { children?: any; className?: string; onDropZone?: (amt:number)=>void; title?: string; style?: CSSProperties; zoneKey: string }) => (
              <div
                ref={(el) => { zoneRefs.current[zoneKey] = el; }}
                onDragOver={(e) => { if (phase==='betting') e.preventDefault(); }}
                onDragEnter={() => { if (phase==='betting') setHoverKey(zoneKey); }}
                onDragLeave={() => { if (phase==='betting' && hoverKey === zoneKey) setHoverKey(null); }}
                onDrop={(e) => { if (phase!=='betting') return; const amt = parseInt(e.dataTransfer.getData('text/plain')); if (!isFinite(amt) || amt<=0) return; onDropZone && onDropZone(amt); setHoverKey(null); e.preventDefault(); }}
                className={`relative flex items-center justify-center text-xs text-white/90 select-none ${className||''}`}
                style={style}
                title={title}
              >
                {/* Hover highlight */}
                {hoverKey === zoneKey && (
                  <div className="absolute inset-0 rounded-[4px] pointer-events-none" style={{ boxShadow:'0 0 0 2px rgba(255,215,96,0.9) inset' }} />
                )}
                {children}
              </div>
            );

            const gridStyle: CSSProperties = { display:'grid', gridTemplateColumns: '60px repeat(12, minmax(0,1fr)) 60px', gridAutoRows: '40px', gap: 2 };
            const box = 'border border-white/10 rounded-[4px]';
            const numBg = (n:number) => redNums.has(n) ? 'bg-[linear-gradient(135deg,#4f0f0f,#8a1717)]' : 'bg-[linear-gradient(135deg,#0f0f17,#202533)]';
            const zoneBg = 'bg-[linear-gradient(135deg,#0f1016,#161b27)]';
            const outsideBg = 'bg-[linear-gradient(135deg,#0e2233,#153552)]';
            const greenBg = 'bg-[linear-gradient(135deg,#0f3320,#145a2d)]';
            const redBg = 'bg-[linear-gradient(135deg,#4f0f0f,#8a1717)]';
            const blackBg = 'bg-[linear-gradient(135deg,#0f0f17,#202533)]';

            return (
              <div style={gridStyle} className="">
                {/* 0 cell spanning 3 rows */}
                <Cell zoneKey={`straight:0`} className={`${box} ${greenBg}`} style={{ gridColumn: '1 / span 1', gridRow: '2 / span 3' }} title="0" onDropZone={(amt) => addBet({ type:'straight', target:'0', amount_cents: amt })}>
                  0
                  {placedMap['straight:0']>0 && (
                    <div className="absolute pointer-events-none" style={{ left: '66%', bottom: 2, transform: 'translateX(-50%)' }}>
                      <ChipStack amountCents={placedMap['straight:0']} chipSize={36} maxColumns={1} />
                    </div>
                  )}
                </Cell>

                {/* Dozens on top row */}
                {['1st 12','2nd 12','3rd 12'].map((label, i) => (
                  <Cell zoneKey={`dozen:${i+1}`} key={label} className={`${box} ${outsideBg}`} style={{ gridColumn: `${2+i*4} / span 4`, gridRow: '1 / span 1' }} title={label}
                    onDropZone={(amt) => addBet({ type:'dozen', target:String(i+1), amount_cents: amt })}
                  >
                    {label}
                    {placedMap[`dozen:${i+1}`]>0 && (
                      <div className="absolute pointer-events-none" style={{ left: '66%', bottom: 2, transform: 'translateX(-50%)' }}>
                        <ChipStack amountCents={placedMap[`dozen:${i+1}`]} chipSize={40} maxColumns={1} />
                      </div>
                    )}
                  </Cell>
                ))}

                {/* Numbers grid 3x12 */}
                {[0,1,2].map(r => (
                  Array.from({ length: 12 }).map((_, c) => {
                    const val = (3 - r) + c*3; // r=0 -> 3,6.. ; r=1 -> 2.. ; r=2 -> 1..
                    const k = `straight:${val}`;
                    return (
                      <Cell zoneKey={`straight:${val}`} key={`n-${r}-${c}`} className={`${box} ${numBg(val)}`} style={{ gridColumn: `${2+c} / span 1`, gridRow: `${2+r} / span 1` }} title={`${val}`}
                         onDropZone={(amt) => addBet({ type:'straight', target:String(val), amount_cents: amt })}
                       >
                        {/* Secondary related highlight for outside bets */}
                {hoverKey && hoverKey !== `straight:${val}` && related.has(val) && (
                  <div className="absolute inset-0 rounded-[4px] pointer-events-none" style={{ boxShadow:'0 0 0 3px rgba(96,165,250,0.95) inset, 0 0 10px rgba(96,165,250,0.5) inset' }} />
                )}
                {/* Landed result highlight */}
                {landed && targetNumber === String(val) && (
                  <div className="absolute inset-0 rounded-[4px] pointer-events-none" style={{ boxShadow:'0 0 0 3px rgba(255,215,96,0.95) inset, 0 0 14px rgba(255,215,96,0.55) inset' }} />
                )}
                          {val}
                          {placedMap[k]>0 && (
                            <div className="absolute pointer-events-none" style={{ left: '66%', bottom: 2, transform: 'translateX(-50%)' }}>
                              <ChipStack amountCents={placedMap[k]} chipSize={36} maxColumns={1} />
                            </div>
                          )}
                      </Cell>
                    );
                  })
                ))}

                {/* Columns (2 to 1) on right side */}
                {[1,2,3].map((colIdx, r) => {
                  const ciTarget = 3 - r; // bottom zone -> 1, middle -> 2, top -> 3
                  return (
                  <Cell zoneKey={`column:${ciTarget}`} key={`col-${ciTarget}`} className={`${box} ${outsideBg}`} style={{ gridColumn: '14 / span 1', gridRow: `${2+r} / span 1` }} title={`Column ${ciTarget} (2 to 1)`}
                    onDropZone={(amt) => addBet({ type:'column', target:String(ciTarget), amount_cents: amt })}
                  >
                    2 to 1
                    {placedMap[`column:${ciTarget}`]>0 && (
                      <div className="absolute pointer-events-none" style={{ left: '66%', bottom: 2, transform: 'translateX(-50%)' }}>
                        <ChipStack amountCents={placedMap[`column:${ciTarget}`]} chipSize={36} maxColumns={1} />
                      </div>
                    )}
                  </Cell>
                  );
                })}

                {/* Bottom even-chance row */}
                {[
                  { label:'1 to 18', key:'low' as const, cls: outsideBg },
                  { label:'EVEN', key:'even' as const, cls: outsideBg },
                  { label:'RED', key:'color:R' as const, cls: redBg },
                  { label:'BLACK', key:'color:B' as const, cls: blackBg },
                  { label:'ODD', key:'odd' as const, cls: outsideBg },
                  { label:'19 to 36', key:'high' as const, cls: outsideBg },
                ].map((z, i) => (
                  <Cell zoneKey={z.key.startsWith('color:') ? `color:${z.key.split(':')[1]}` : `${(z.key as string)}:${(z.key==='low'?'LOW': z.key==='high'?'HIGH': z.key==='even'?'EVEN':'ODD')}`} key={z.label} className={`${box} ${z.cls}`} style={{ gridColumn: `${2+i*2} / span 2`, gridRow: '5 / span 1' }} title={z.label}
                    onDropZone={(amt) => {
                      if (z.key.startsWith('color:')) addBet({ type:'color', target:z.key.split(':')[1], amount_cents: amt });
                      else addBet({ type: z.key as any, target: z.key.toUpperCase(), amount_cents: amt });
                    }}
                  >
                     {z.label}
                     {(() => {
                       const type = z.key.startsWith('color:') ? 'color' : (z.key as string);
                       const target = z.key.startsWith('color:') ? z.key.split(':')[1] : (z.key==='low'?'LOW': z.key==='high'?'HIGH': z.key==='even'?'EVEN':'ODD');
                       const pk = `${type}:${target}`;
                       const amt = placedMap[pk] || 0;
                      return amt>0 ? (
                        <div className="absolute pointer-events-none" style={{ left: '66%', bottom: 2, transform: 'translateX(-50%)' }}>
                          <ChipStack amountCents={amt} chipSize={40} maxColumns={1} />
                        </div>
                        ) : null;
                      })()}
                   </Cell>
                ))}
              </div>
            );
          })()}

          {error && <div className="mt-2 text-danger text-sm">{error}</div>}
          <div className="mt-3 flex items-center justify-between">
            <div className="text-sm text-white/70">Potential winnings: <span className="text-white font-semibold">${(potentialReturnCents/100).toFixed(2)}</span></div>
            <Button disabled={!canSubmit} onClick={submitBets}>Submit Bet</Button>
          </div>
          {/* No explicit 'No more bets' banner during spin */}
        </div>

        {/* Summary panel (Roulette style like Blackjack) */}
        <div className="rounded-2xl bg-card/70 border border-white/10 p-4">
          {phase === 'betting' && (
            <>
              <div className="text-lg font-semibold mb-2">Round Summary</div>
              <div className="text-white/70 text-sm">Place chips to see potential payouts.</div>
            </>
          )}

          {landed && (
            <div>
              {/* Big payout banner when settled (match Blackjack feel) */}
              <div className="text-2xl font-extrabold text-green-400 mb-3">
                {totalPayout > 0 ? `Payout +$${totalPayout.toFixed(2)}` : 'No Payout'}
              </div>

              <div className="font-semibold mb-2">Round Summary</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>Winning Pocket:</div>
                <div className="text-right font-semibold">
                  {targetNumber ?? '—'}{targetColor ? ` (${targetColor === 'R' ? 'Red' : targetColor === 'B' ? 'Black' : 'Green'})` : ''}
                </div>
                <div>Total Wager:</div>
                <div className="text-right">${(totalWager/100).toFixed(2)}</div>
                <div>Wins:</div>
                <div className="text-right">
                  {payouts.filter(p => p.win_amount > 0).length > 0 ? payouts.filter(p => p.win_amount > 0).map(p => formatSelection(p.selection)).join(', ') : 'None'}
                </div>
              </div>

              {/* Next round button (replaces technical details) */}
              <div className="mt-4">
                <Button onClick={nextRound}>Next round</Button>
              </div>
            </div>
          )}
        </div>
      </div>
      <ChipFlightOverlay flights={flyingChips} chipSize={32} durationMs={500} />
    </div>
  );
}

// legacy BetCell removed; using drag-and-drop board instead
