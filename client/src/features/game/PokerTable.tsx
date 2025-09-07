import { useEffect, useMemo, useRef, useState } from "react";
import { api, API_BASE } from "../../api/client";
import Button from "../../components/Button";
import Card from "../../components/Card";
import ChipStack from "../../components/ChipStack";
import {
  ChipFlightOverlay,
  buildChipFlights,
  getNavBalanceTarget,
} from "../../components/ChipFlight";
import { useAuthStore } from "../../store/auth";

/** ---------- Types ---------- */

type TableSummary = {
  id: string;
  name: string;
  isPrivate: boolean;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number; // cents
  maxBuyIn: number; // cents
  maxSeats: number;
  seatsTaken: number;
  status: string;
};

type Seat = {
  seat_no: number;
  user_id?: number | string | null;
  username?: string | null;
  stack: number; // cents
  sitting_out: boolean;
  connected: boolean;
};

type Suit = "S" | "H" | "D" | "C";
type Rank = number; // 2-14 (A=14)

type PlayerPublic = {
  seatNo: number;
  hasFolded: boolean;
  isAllIn: boolean;
  streetBet: number; // cents
  totalContrib: number; // cents
};

type Street = "preflop" | "flop" | "turn" | "river";

type HandView = {
  handId: number;
  dealerSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  deckCommit: string;
  board: [Rank, Suit][];
  pot: number; // cents
  stage: Street;
  toAct?: number | null;
  minRaise: number; // cents
  curBet: number; // cents
  players: PlayerPublic[];
  /** Server includes your hole cards for UX */
  myHole?: [[Rank, Suit], [Rank, Suit]];
} | null;

type TableSnapshot = {
  table: {
    id: string;
    name: string;
    smallBlind: number;
    bigBlind: number;
    minBuyIn: number;
    maxBuyIn: number;
    maxSeats: number;
  };
  seats: Seat[];
  hand: HandView;
};

type WsEvent =
  | { type: "TABLE_SNAPSHOT"; state: TableSnapshot }
  | {
      type: "PLAYER_SEATED";
      seatNo: number;
      user: { id: number | string; name: string };
    }
  | { type: "BUY_IN_APPLIED"; seatNo: number; amount: number; stack: number }
  | { type: "PLAYER_LEFT"; seatNo: number }
  | { type: "PLAYER_SIT_OUT"; seatNo: number }
  | { type: "PLAYER_SIT_IN"; seatNo: number }
  | {
      type: "HAND_STARTED";
      handId: number;
      dealerSeat: number;
      smallBlindSeat: number;
      bigBlindSeat: number;
      deckCommit: string;
    }
  | { type: "DEAL_FLOP"; cards: [Rank, Suit][] }
  | { type: "DEAL_TURN"; card: [Rank, Suit] }
  | { type: "DEAL_RIVER"; card: [Rank, Suit] }
  | {
      type: "ACTION_REQUIRED";
      seatNo: number;
      minRaise: number;
      toCall: number;
      timeLeftMs: number;
    }
  | {
      type: "PLAYER_ACTION_APPLIED";
      seatNo: number;
      action: "fold" | "check" | "call" | "bet" | "raise";
      amount: number;
      toCallNext: number;
    }
  | { type: "POT_AWARDED"; potIndex: number; seatNo: number; amount: number }
  | { type: "SHOWDOWN"; hands: any; pots: any }
  | { type: "HAND_ENDED"; nextDealerSeat: number; seed?: string; waitMs?: number }
  | { type: "CASHED_OUT"; seatNo: number; amount: number }
  | { type: "CASH_OUT_OK"; amount: number; newBalance: number }
  | { type: "ERROR"; reason: string };

/** ---------- Helpers ---------- */

const sameId = (
  a: number | string | null | undefined,
  b: number | string | null | undefined
) => a != null && b != null && String(a) === String(b);

function buildWsUrl(path: string) {
  const apiBase = API_BASE || "/api";
  const baseUrl = /^https?:\/\//i.test(apiBase)
    ? new URL(apiBase)
    : new URL(apiBase, window.location.origin);
  const wsProto = baseUrl.protocol === "https:" ? "wss:" : "ws:";
  const pathBase = baseUrl.pathname.replace(/\/$/, "");
  return `${wsProto}//${baseUrl.host}${pathBase}${path}`;
}

/** Small helpers for hand naming (client-only, simplified) */
const RANK_LABEL: Record<number, string> = {
  14: "A",
  13: "K",
  12: "Q",
  11: "J",
  10: "10",
  9: "9",
  8: "8",
  7: "7",
  6: "6",
  5: "5",
  4: "4",
  3: "3",
  2: "2",
};

function labelBestHand(hole?: [[Rank, Suit], [Rank, Suit]], board?: [Rank, Suit][]) {
  if (!hole || hole.length !== 2) return "";
  const cards = [...hole, ...(board ?? [])];
  const ranks = cards.map((c) => c[0]);
  const suits = cards.map((c) => c[1]);

  // Counts
  const rc: Record<number, number> = {};
  for (const r of ranks) rc[r] = (rc[r] || 0) + 1;
  const sc: Record<string, number> = {};
  for (const s of suits) sc[s] = (sc[s] || 0) + 1;

  const isFlush = Object.values(sc).some((v) => v >= 5);

  // Straight-ish check
  const uniq = Array.from(new Set(ranks)).sort((a, b) => b - a);
  const seq = [...uniq, uniq.includes(14) ? 1 : null].filter(Boolean) as number[];
  let straightHigh = 0;
  let run = 1;
  for (let i = 0; i < seq.length - 1; i++) {
    if (seq[i] - 1 === seq[i + 1]) {
      run++;
      if (run >= 5) straightHigh = Math.max(straightHigh, seq[i - 3]);
    } else if (seq[i] !== seq[i + 1]) {
      run = 1;
    }
  }

  const pairs = Object.entries(rc)
    .filter(([, c]) => c === 2)
    .map(([r]) => Number(r))
    .sort((a, b) => b - a);
  const trips = Object.entries(rc)
    .filter(([, c]) => c === 3)
    .map(([r]) => Number(r))
    .sort((a, b) => b - a);
  const quads = Object.entries(rc)
    .filter(([, c]) => c === 4)
    .map(([r]) => Number(r))
    .sort((a, b) => b - a);

  if (isFlush && straightHigh) return `Straight Flush`;
  if (quads.length) return `Four of a Kind ${RANK_LABEL[quads[0]]}`;
  if (trips.length && (trips.length >= 2 || pairs.length)) return `Full House`;
  if (isFlush) return `Flush`;
  if (straightHigh) return `Straight`;
  if (trips.length) return `Three of a Kind ${RANK_LABEL[trips[0]]}`;
  if (pairs.length >= 2) return `Two Pair ${RANK_LABEL[pairs[0]]}-${RANK_LABEL[pairs[1]]}`;
  if (pairs.length === 1) return `Pair ${RANK_LABEL[pairs[0]]}`;

  // High card
  const top = uniq[0];
  return `High Card ${RANK_LABEL[top]}`;
}

/** ---------- Component ---------- */

export default function PokerTable() {
  const me = useAuthStore((s) => s.me);
  const fetchMe = useAuthStore((s) => s.fetchMe);
  const setMe = useAuthStore((s) => s.setMe);

  const [tables, setTables] = useState<TableSummary[]>([]);
  const [selected, setSelected] = useState<TableSummary | null>(null);

  const [seats, setSeats] = useState<Seat[]>([]);
  const [hand, setHand] = useState<HandView>(null);

  const [error, setError] = useState<string | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [connectedTableId, setConnectedTableId] = useState<string | null>(null);

  const [mySeat, setMySeat] = useState<number | null>(null);
  const mySeatRef = useRef<number | null>(null);

  const [leaving, setLeaving] = useState(false);

  // Sit modal
  const [showSitModal, setShowSitModal] = useState(false);
  const [pendingSeat, setPendingSeat] = useState<number | null>(null);
  const [sitDollars, setSitDollars] = useState<string>("");

  // Buy-in (cents in `amount`)
  const awaitingBuyIn = useRef<{ seatNo: number; amountCents: number } | null>(
    null
  );
  const buyInRetryTimerRef = useRef<number | null>(null);
  const buyInAttemptRef = useRef<number>(0);

  // Chip flights + seat refs
  const [flyingChips, setFlyingChips] = useState<any[]>([]);
  const potRef = useRef<HTMLDivElement | null>(null);
  const seatRefs = useRef<Record<number, HTMLDivElement | null>>({});

  // Betting controls and countdown
  const [actionSeat, setActionSeat] = useState<number | null>(null);
  const [toCall, setToCall] = useState<number>(0); // cents
  const [minRaise, setMinRaise] = useState<number>(0); // cents
  const [deadline, setDeadline] = useState<number | null>(null); // epoch ms
  const [betInput, setBetInput] = useState<string>(""); // dollars string
  const [countdownNow, setCountdownNow] = useState<number>(Date.now());

  // Inter-hand pause display
  const [interWaitUntil, setInterWaitUntil] = useState<number | null>(null);

  // Winner flash
  const [winnerFlash, setWinnerFlash] = useState<Record<number, number>>({}); // seatNo -> untilTs

  // keep ticking
  useEffect(() => {
    const t = window.setInterval(() => setCountdownNow(Date.now()), 120);
    return () => clearInterval(t);
  }, []);

  // cached map for quick lookup
  const playersBySeat = useMemo(() => {
    const map = new Map<number, PlayerPublic>();
    (hand?.players ?? []).forEach((p) => map.set(p.seatNo, p));
    return map;
  }, [hand?.players]);

  const myPlayer = mySeat != null ? playersBySeat.get(mySeat) || null : null;

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);
  useEffect(() => {
    loadTables();
  }, []);
  useEffect(() => {
    mySeatRef.current = mySeat;
  }, [mySeat]);

  async function loadTables() {
    try {
      const list = await api<TableSummary[]>(`/poker/tables`);
      const main = list.find((t) => t.id === "main") || null;
      setTables(list);
      setSelected((prev) => prev ?? main ?? list[0] ?? null);
    } catch (e: any) {
      setError(e?.message || "Failed to load tables");
    }
  }

  async function joinTable(t: TableSummary) {
    try {
      if (ws) {
        try {
          ws.close();
        } catch {}
      }
      await api(`/poker/join`, {
        method: "POST",
        body: JSON.stringify({ tableId: t.id }),
      });
      setSelected(t);
      openWs(t.id);
    } catch (e: any) {
      setError(e?.message || "Failed to join table");
    }
  }

  function openWs(tableId: string) {
    try {
      if (ws) ws.close();
    } catch {}
    const socket = new WebSocket(buildWsUrl(`/poker/ws/${tableId}`));
    socket.onopen = () => {
      setWs(socket);
      setConnectedTableId(tableId);
    };
    socket.onmessage = (ev) => {
      try {
        const msg: WsEvent = JSON.parse(ev.data);
        handleWsEvent(msg);
      } catch {}
    };
    socket.onclose = () => {
      setWs(null);
      setConnectedTableId(null);
      setSeats([]);
      setHand(null);
      setActionSeat(null);
      setDeadline(null);
      setInterWaitUntil(null);
    };
  }

  function handleWsEvent(msg: WsEvent) {
    switch (msg.type) {
      case "TABLE_SNAPSHOT": {
        const { table, seats, hand } = msg.state;
        setSelected((prev) => ({
          id: table.id,
          name: table.name,
          isPrivate: false,
          smallBlind: table.smallBlind,
          bigBlind: table.bigBlind,
          minBuyIn: table.minBuyIn,
          maxBuyIn: table.maxBuyIn,
          maxSeats: table.maxSeats,
          seatsTaken: prev?.seatsTaken ?? 0,
          status: hand ? "running" : "waiting",
        }));
        setSeats(seats);
        setHand(hand);

        const mine = seats.find((s) => sameId(s.user_id, me?.id));
        setMySeat(mine ? mine.seat_no : null);
        mySeatRef.current = mine ? mine.seat_no : null;

        if (hand?.toAct != null) {
          setActionSeat(hand.toAct);
        } else {
          setActionSeat(null);
        }

        // if we were waiting to buy-in and snapshot shows us seated, send it
        if (
          awaitingBuyIn.current &&
          mine &&
          mine.seat_no === awaitingBuyIn.current.seatNo
        ) {
          sendBuyInOnce();
        }
        break;
      }

      case "PLAYER_SEATED": {
        if (
          awaitingBuyIn.current &&
          msg.seatNo === awaitingBuyIn.current.seatNo &&
          (!me?.id || sameId(msg.user?.id, me?.id))
        ) {
          setMySeat(msg.seatNo);
          mySeatRef.current = msg.seatNo;
          sendBuyInOnce();
        } else if (sameId(msg.user?.id, me?.id)) {
          setMySeat(msg.seatNo);
          mySeatRef.current = msg.seatNo;
        }
        break;
      }

      case "BUY_IN_APPLIED": {
        if (buyInRetryTimerRef.current) {
          clearTimeout(buyInRetryTimerRef.current);
          buyInRetryTimerRef.current = null;
        }
        setSeats((prev) =>
          prev.map((s) =>
            s.seat_no === msg.seatNo ? { ...s, stack: msg.stack } : s
          )
        );

        // optimistic wallet update then refresh
        const mineSeat = seats.find((s) => s.seat_no === msg.seatNo);
        if (mineSeat && sameId(mineSeat.user_id, me?.id) && me) {
          setMe({
            ...me,
            balance_cents: Math.max(0, (me.balance_cents ?? 0) - msg.amount),
          });
        }
        fetchMe();

        awaitingBuyIn.current = null;
        setShowSitModal(false);
        setPendingSeat(null);
        setError(null);
        break;
      }

      case "ACTION_REQUIRED": {
        setActionSeat(msg.seatNo);
        setMinRaise(msg.minRaise);
        setToCall(msg.toCall);
        setDeadline(Date.now() + (msg.timeLeftMs || 0));
        // suggest next total bet
        const cb = hand?.curBet ?? 0;
        const target = Math.max(cb + msg.minRaise, cb);
        setBetInput((target / 100).toFixed(2));
        break;
      }

      case "POT_AWARDED": {
        // winner glow + chip flight
        setWinnerFlash((prev) => ({
          ...prev,
          [msg.seatNo]: Date.now() + 1400,
        }));
        try {
          if (!potRef.current) break;
          const target = seatRefs.current[msg.seatNo];
          if (!target) break;
          const src = potRef.current.getBoundingClientRect();
          const { flights } = buildChipFlights(msg.amount, src, target, {
            chipSize: 24,
            interDelay: 60,
            maxChips: 10,
          });
          setFlyingChips(flights);
          setTimeout(() => setFlyingChips([]), 1200);
        } catch {}
        break;
      }

      case "HAND_ENDED": {
        // show inter-hand countdown if provided
        if (typeof msg.waitMs === "number" && msg.waitMs > 0) {
          setInterWaitUntil(Date.now() + msg.waitMs);
        } else {
          setInterWaitUntil(null);
        }
        setActionSeat(null);
        setDeadline(null);
        break;
      }

      case "CASH_OUT_OK": {
        try {
          const target = getNavBalanceTarget();
          const src =
            mySeat != null ? seatRefs.current[mySeat] : null;
        if (target && src) {
            const rect = src.getBoundingClientRect();
            const { flights } = buildChipFlights(msg.amount, rect, target, {
              chipSize: 24,
              interDelay: 60,
              maxChips: 10,
            });
            setFlyingChips(flights);
            setTimeout(() => setFlyingChips([]), 1200);
          }
        } catch {}
        if (me) setMe({ ...me, balance_cents: msg.newBalance });
        fetchMe();

        if (leavingRef.current && ws) {
          try {
            ws.close();
          } catch {}
          setWs(null);
          setConnectedTableId(null);
          setSeats([]);
          setHand(null);
          leavingRef.current = false;
          setLeaving(false);
        }
        break;
      }

      case "ERROR": {
        const reason = (msg.reason || "").trim();
        // ignore buy-in positive message that can race with hedged payloads
        if (/buy[- ]?in must be positive/i.test(reason)) break;
        setError(reason || "Action failed");
        break;
      }

      default:
        break;
    }
  }

  function sendWs(obj: any) {
    try {
      ws?.send(JSON.stringify(obj));
    } catch {}
  }

  /** Send one BUY_IN using integer cents in the `amount` field */
  function sendBuyInOnce() {
    if (!awaitingBuyIn.current) return;
    const { seatNo, amountCents } = awaitingBuyIn.current;
    const finalSeat =
      mySeatRef.current != null && mySeatRef.current >= 0
        ? mySeatRef.current
        : typeof seatNo === "number" && seatNo >= 0
        ? seatNo
        : null;
    if (finalSeat == null) return;
    sendWs({ type: "BUY_IN", amount: amountCents, seatNo: finalSeat });
  }

  /** Retry until seated to send the buy-in exactly once */
  function startBuyInRetry() {
    if (buyInRetryTimerRef.current) {
      clearTimeout(buyInRetryTimerRef.current);
      buyInRetryTimerRef.current = null;
    }
    buyInAttemptRef.current = 0;

    const trySend = () => {
      if (!awaitingBuyIn.current) return;
      if (
        mySeatRef.current != null &&
        mySeatRef.current === awaitingBuyIn.current.seatNo
      ) {
        sendBuyInOnce();
      }
      buyInAttemptRef.current += 1;
      if (buyInAttemptRef.current < 12 && awaitingBuyIn.current) {
        buyInRetryTimerRef.current = window.setTimeout(trySend, 400);
      } else {
        buyInRetryTimerRef.current = null;
      }
    };

    buyInRetryTimerRef.current = window.setTimeout(trySend, 300);
  }

  function takeSeat(seatNo: number) {
    setPendingSeat(seatNo);
    setSitDollars(((selected?.minBuyIn ?? 0) / 100).toFixed(2));
    setShowSitModal(true);
  }

  function confirmSit() {
    const dollars = Number(sitDollars || "0");
    const amountCents = Math.max(0, Math.round(dollars * 100));

    if (!me || (me.balance_cents ?? 0) < amountCents) {
      setError("Insufficient balance");
      return;
    }

    if (pendingSeat != null) {
      awaitingBuyIn.current = { seatNo: pendingSeat, amountCents };
      setError(null);
      sendWs({ type: "SEAT_TAKE", seatNo: pendingSeat });
      startBuyInRetry();
    } else {
      if (mySeatRef.current == null) {
        setError("You must be seated to top up");
        return;
      }
      awaitingBuyIn.current = { seatNo: mySeatRef.current, amountCents };
      setError(null);
      sendBuyInOnce();
    }
  }

  function cancelSit() {
    setShowSitModal(false);
    setPendingSeat(null);
    awaitingBuyIn.current = null;
    if (buyInRetryTimerRef.current) {
      clearTimeout(buyInRetryTimerRef.current);
      buyInRetryTimerRef.current = null;
    }
  }

  function cashOut() {
    sendWs({ type: "CASH_OUT" });
  }

  // Ensure cash out before leaving the table to avoid desync
  const leavingRef = useRef(false);
  function leaveTable() {
    if (!ws) return;
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);

    if (mySeat != null) {
      try {
        sendWs({ type: "CASH_OUT" });
      } catch {}
      setTimeout(() => {
        try {
          ws.close();
        } catch {}
        setWs(null);
        setConnectedTableId(null);
        setSeats([]);
        setHand(null);
        leavingRef.current = false;
        setLeaving(false);
      }, 2500);
    } else {
      try {
        ws.close();
      } catch {}
      setWs(null);
      setConnectedTableId(null);
      setSeats([]);
      setHand(null);
      leavingRef.current = false;
      setLeaving(false);
    }
  }

  const seatedMe = useMemo(
    () => seats.find((s) => sameId(s.user_id, me?.id)) ?? null,
    [seats, me?.id]
  );

  const potCents = hand?.pot ?? 0;

  // ------- Betting UI helpers -------

  const isMyTurn =
    actionSeat != null && mySeat != null && actionSeat === mySeat;
  const myCanAct =
    isMyTurn && myPlayer && !myPlayer.hasFolded && !myPlayer.isAllIn;

  const myStackApprox = useMemo(() => {
    if (mySeat == null) return 0;
    const s = seats.find((x) => x.seat_no === mySeat);
    return s?.stack ?? 0;
  }, [seats, mySeat]);

  const curBet = hand?.curBet ?? 0;

  function sendPlayerAction(
    kind: "fold" | "check" | "call" | "bet" | "raise",
    amountCents?: number
  ) {
    if (!ws) return;
    const payload: any = { type: "PLAYER_ACTION", action: kind };
    if (amountCents != null) payload.amount = amountCents;
    sendWs(payload);
  }

  // countdown 0..1 used
  const countdownUsed = useMemo(() => {
    if (!deadline) return 0;
    const msLeft = Math.max(0, deadline - countdownNow);
    const total = Math.max(1, (deadline - (deadline - (hand ? 0 : 0))));
    const used = 1 - msLeft / Math.max(1, total);
    return Math.max(0, Math.min(1, used));
  }, [deadline, countdownNow, hand?.handId]);

  // inter-hand seconds left
  const interLeft = useMemo(() => {
    if (!interWaitUntil) return 0;
    return Math.max(0, Math.ceil((interWaitUntil - Date.now()) / 1000));
  }, [interWaitUntil, countdownNow]);

  // Hand label for me
  const myHandLabel = useMemo(
    () => labelBestHand(hand?.myHole, hand?.board),
    [hand?.myHole, hand?.board]
  );

  // ------- Layout helpers -------

  // Precompute seat positions evenly on a circle, using table max seats
  const seatPositions = useMemo(() => {
    const count = selected?.maxSeats || seats.length || 6;
    const list: { left: number; top: number; angle: number }[] = [];
    const radius = 210;
    const centerX = 360; // center of felt container (width ~720)
    const centerY = 300; // slightly below board/pot cluster
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const left = centerX + Math.cos(angle) * radius;
      const top = centerY + Math.sin(angle) * radius;
      list.push({ left, top, angle });
    }
    return list;
  }, [selected?.maxSeats, seats.length]);

  // Utility: winner glow active?
  function winnerGlowClass(seatNo: number) {
    const until = winnerFlash[seatNo] || 0;
    return until > Date.now()
      ? "ring-2 ring-green-400 shadow-[0_0_20px_rgba(34,197,94,0.45)]"
      : "";
  }

  // ------- Render -------

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6">
      <div className="rounded-2xl bg-card border border-white/10 p-4">
        <div className="flex items-center justify-between mb-1">
          <div className="text-xl font-bold">Texas Hold&apos;em</div>
          <div className="text-sm text-white/70">
            Blinds: ${(selected?.smallBlind ?? 0) / 100}/
            {(selected?.bigBlind ?? 0) / 100}
          </div>
        </div>
        <div className="text-xs text-white/60 mb-3">
          Main table is always open and public for quick play.
        </div>

        {/* Table Felt */}
        <div className="relative h-[560px] rounded-2xl bg-gradient-to-b from-emerald-900/40 to-emerald-800/30 border border-white/10 overflow-hidden">
          {ws && (
            <>
              {/* Inter-hand overlay */}
              {interWaitUntil && interLeft > 0 && (
                <div className="absolute inset-x-0 top-2 mx-auto w-fit rounded-full bg-white/10 px-3 py-1 text-sm text-white/80 border border-white/15">
                  Next hand in {interLeft}s
                </div>
              )}

              {/* Pot cluster */}
              <div
                ref={potRef}
                className="absolute left-1/2 top-[42%] -translate-x-1/2 -translate-y-1/2 flex flex-col items-center"
              >
                <div className="text-xs text-white/70">Pot</div>
                <ChipStack amountCents={potCents} chipSize={28} />
                <div className="text-white/80 text-sm mt-1">
                  ${(potCents / 100).toFixed(2)}
                </div>
              </div>

              {/* Board cards with gentle flip-in on change */}
              <div className="absolute left-1/2 top-[24%] -translate-x-1/2 flex gap-2">
                {(hand?.board ?? []).map((c, i) => (
                  <div
                    key={`${c[0]}${c[1]}-${i}`}
                    className="animate-[fadeIn_240ms_ease-out] will-change-transform"
                  >
                    <Card rank={String(c[0])} suit={c[1]} />
                  </div>
                ))}
              </div>

              {/* Seats */}
              {seats.map((s, idx) => {
                const seatIndex = s.seat_no ?? idx;
                const pos = seatPositions[seatIndex] || {
                  left: 360,
                  top: 300,
                  angle: 0,
                };
                const isMe = sameId(s.user_id, me?.id);
                const pub = playersBySeat.get(seatIndex);
                const isActing = actionSeat === seatIndex;

                const myHole = isMe ? hand?.myHole : undefined;
                const isDealer = hand?.dealerSeat === seatIndex;

                // timer ring numbers
                const R = 26; // radius
                const C = 2 * Math.PI * R;
                const used = isActing ? countdownUsed : 0; // 0..1
                const dash = Math.max(0, C * (1 - used)); // remaining circumference
                const dashOffset = 0; // draw from start; we rotate to make it "unfill" CCW

                return (
                  <div
                    key={seatIndex}
                    ref={(el) => (seatRefs.current[seatIndex] = el)}
                    className={`absolute -translate-x-1/2 -translate-y-1/2 w-[176px]`}
                    style={{ left: pos.left, top: pos.top }}
                  >
                    {/* Turn timer ring */}
                    <svg
                      viewBox="0 0 64 64"
                      width="64"
                      height="64"
                      className="absolute -left-3 -top-3 pointer-events-none"
                      style={{
                        transform: "rotate(90deg) scaleX(-1)", // makes it unfill CCW
                        opacity: isActing ? 1 : 0.25,
                        transition: "opacity 120ms linear",
                      }}
                    >
                      <circle
                        cx="32"
                        cy="32"
                        r={R}
                        fill="none"
                        stroke="rgba(255,255,255,0.15)"
                        strokeWidth="6"
                      />
                      <circle
                        cx="32"
                        cy="32"
                        r={R}
                        fill="none"
                        stroke="var(--accent, #22d3ee)"
                        strokeWidth="6"
                        strokeLinecap="round"
                        strokeDasharray={`${dash} ${C}`}
                        strokeDashoffset={dashOffset}
                        style={{ transition: "stroke-dasharray 120ms linear" }}
                      />
                    </svg>

                    {/* Seat panel */}
                    <div
                      className={[
                        "rounded-xl border bg-black/30 px-3 py-2",
                        isMe ? "border-accent" : "border-white/10",
                        pub?.isAllIn ? "ring-1 ring-yellow-400/60" : "",
                        pub?.hasFolded ? "opacity-60" : "",
                        winnerGlowClass(seatIndex),
                      ].join(" ")}
                    >
                      <div className="flex items-center gap-2">
                        <div className="text-sm font-semibold truncate">
                          {s.username || "Empty"}
                        </div>
                        {isDealer && (
                          <div className="ml-auto shrink-0 w-5 h-5 grid place-items-center rounded-full bg-white/90 text-black text-[10px] font-bold">
                            D
                          </div>
                        )}
                      </div>

                      {/* Chips */}
                      <div className="mt-1">
                        <ChipStack amountCents={s.stack} chipSize={18} />
                      </div>
                      <div className="text-xs text-white/70 mt-0.5">
                        ${(s.stack / 100).toFixed(2)}
                      </div>

                      {/* Hole cards */}
                      <div className="mt-1 flex gap-1">
                        {isMe ? (
                          myHole && myHole.length === 2 ? (
                            <>
                              <Card rank={String(myHole[0][0])} suit={myHole[0][1]} />
                              <Card rank={String(myHole[1][0])} suit={myHole[1][1]} />
                            </>
                          ) : (
                            <>
                              <Card rank={""} suit={"S"} faceDown />
                              <Card rank={""} suit={"S"} faceDown />
                            </>
                          )
                        ) : pub ? (
                          <>
                            <Card rank={""} suit={"S"} faceDown />
                            <Card rank={""} suit={"S"} faceDown />
                          </>
                        ) : null}
                      </div>

                      {/* Sit button */}
                      {!s.user_id && mySeat == null && (
                        <Button
                          className="mt-2 px-2 py-1 w-full"
                          onClick={() => takeSeat(seatIndex)}
                        >
                          Take
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Stand Up */}
              {mySeat != null && (
                <div className="absolute bottom-4 right-4">
                  <Button
                    onClick={cashOut}
                    className="px-3 py-2 bg-red-600 hover:bg-red-500 text-white border border-red-500/40"
                  >
                    Stand Up (Cash Out)
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Betting controls + My hand helper */}
        <div className="mt-3 rounded-xl bg-black/20 border border-white/10 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm text-white/70">
              {actionSeat != null ? `To act: Seat ${actionSeat}` : "Waiting…"}
              {isMyTurn && deadline
                ? ` • ${Math.max(
                    0,
                    Math.ceil((deadline - countdownNow) / 1000)
                  )}s`
                : ""}
            </div>
            <div className="ml-auto text-xs text-white/60">
              {isMyTurn ? (
                <>
                  To call: ${(toCall / 100).toFixed(2)} • Min raise: $
                  {(minRaise / 100).toFixed(2)} • Current bet: $
                  {(curBet / 100).toFixed(2)}
                </>
              ) : null}
            </div>
          </div>

          {/* My hand helper */}
          {hand?.myHole && (
            <div className="mt-2 text-sm text-white/80">
              Your hand:{" "}
              <span className="font-semibold text-white">{myHandLabel}</span>
            </div>
          )}

          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              onClick={() => sendPlayerAction("fold")}
              disabled={!myCanAct}
              className="px-3 py-1"
            >
              Fold
            </Button>
            <Button
              onClick={() => sendPlayerAction("check")}
              disabled={!myCanAct || toCall > 0}
              className="px-3 py-1"
            >
              Check
            </Button>
            <Button
              onClick={() => sendPlayerAction("call")}
              disabled={!myCanAct || toCall === 0}
              className="px-3 py-1"
            >
              Call ${(toCall / 100).toFixed(2)}
            </Button>

            {/* Bet / Raise to-total input (dollars) */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-white/70">To</span>
              <input
                type="number"
                step={0.01}
                value={betInput}
                onChange={(e) => setBetInput(e.target.value)}
                className="w-24 rounded-md bg-black/30 border border-white/10 px-2 py-1 text-white/90"
                disabled={!myCanAct}
              />
              {curBet === 0 ? (
                <Button
                  onClick={() => {
                    const toTotal = Math.round(Number(betInput || "0") * 100);
                    if (!Number.isFinite(toTotal) || toTotal <= 0) return;
                    if (toTotal < minRaise) return;
                    sendPlayerAction("bet", toTotal);
                  }}
                  disabled={!myCanAct}
                >
                  Bet
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    const toTotal = Math.round(Number(betInput || "0") * 100);
                    if (!Number.isFinite(toTotal) || toTotal <= 0) return;
                    sendPlayerAction("raise", toTotal);
                  }}
                  disabled={!myCanAct}
                >
                  Raise
                </Button>
              )}
            </div>

            {/* Quick presets */}
            <div className="flex items-center gap-2 ml-auto">
              <QuickTo
                onClick={(v) => setBetInput(v.toFixed(2))}
                bb={(selected?.bigBlind ?? 100) / 100}
                label="2x"
                mult={2}
              />
              <QuickTo
                onClick={(v) => setBetInput(v.toFixed(2))}
                bb={(selected?.bigBlind ?? 100) / 100}
                label="3x"
                mult={3}
              />
              <QuickTo
                onClick={(v) => setBetInput(v.toFixed(2))}
                bb={(selected?.bigBlind ?? 100) / 100}
                label="Pot"
                pot={potCents / 100}
              />
              <QuickTo
                onClick={(v) => setBetInput(v.toFixed(2))}
                bb={(selected?.bigBlind ?? 100) / 100}
                label="All-in"
                stack={myStackApprox / 100}
              />
            </div>
          </div>
        </div>

        {ws && !seatedMe && (
          <div className="mt-3 text-white/70">Pick a seat to start.</div>
        )}
        {error && <div className="text-danger mt-2 text-sm">{error}</div>}
      </div>

      {/* Lobby */}
      <div className="rounded-2xl bg-card border border-white/10 p-4">
        <div className="text-white/70 text-sm mb-2">Table Lobby</div>
        <div className="space-y-2">
          {tables.map((t) => {
            const joined = connectedTableId === t.id && !!ws;
            return (
              <div
                key={t.id}
                className={`rounded-lg border ${
                  selected?.id === t.id ? "border-accent" : "border-white/10"
                } p-3 flex items-center justify-between`}
              >
                <div>
                  <div className="font-semibold">{t.name}</div>
                  <div className="text-xs text-white/70">
                    {t.seatsTaken}/{t.maxSeats} seats • Blinds{" "}
                    {(t.smallBlind / 100).toFixed(2)}/
                    {(t.bigBlind / 100).toFixed(2)}
                  </div>
                </div>
                {!joined ? (
                  <Button onClick={() => joinTable(t)} className="px-3 py-1">
                    Join
                  </Button>
                ) : (
                  <Button
                    onClick={() => leaveTable()}
                    disabled={leaving}
                    className={`px-3 py-1 border ${
                      leaving
                        ? "bg-red-600/60 text-white/70 border-red-500/20 cursor-not-allowed"
                        : "bg-red-600 hover:bg-red-500 text-white border-red-500/40"
                    }`}
                  >
                    {leaving ? "Leaving…" : "Leave"}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Chip animation overlay */}
      <ChipFlightOverlay flights={flyingChips} chipSize={28} durationMs={500} />

      {/* Sit Down Modal */}
      {showSitModal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60">
          <div className="w-[360px] rounded-xl bg-card border border-white/10 p-4">
            <div className="text-lg font-semibold mb-2">Sit Down</div>
            <div className="text-sm text-white/70 mb-2">
              Enter buy in amount in dollars.
            </div>
            <div className="flex items-center gap-2">
              <span className="text-white/80">$</span>
              <input
                type="number"
                min={(selected?.minBuyIn ?? 0) / 100}
                max={(selected?.maxBuyIn ?? 0) / 100}
                step={0.01}
                value={sitDollars}
                onChange={(e) => setSitDollars(e.target.value)}
                className="w-40 rounded-md bg-black/30 border border-white/10 px-2 py-1 text-white/90"
                placeholder="0.00"
              />
              <div className="text-xs text-white/60">
                Min: {((selected?.minBuyIn ?? 0) / 100).toFixed(2)} • Max:{" "}
                {((selected?.maxBuyIn ?? 0) / 100).toFixed(2)}
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="secondary" onClick={cancelSit}>
                Cancel
              </Button>
              <Button
                onClick={confirmSit}
                disabled={
                  !me ||
                  Number(sitDollars || "0") <= 0 ||
                  (me?.balance_cents ?? 0) <
                    Math.round(Number(sitDollars || "0") * 100) ||
                  (pendingSeat != null &&
                    (Math.round(Number(sitDollars || "0") * 100) <
                      (selected?.minBuyIn ?? 0) ||
                      Math.round(Number(sitDollars || "0") * 100) >
                        (selected?.maxBuyIn ?? Infinity)))
                }
              >
                Confirm
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Quick preset helper: either multiples of BB or pot/all-in */
function QuickTo(props: {
  label: string;
  bb: number;
  mult?: number;
  pot?: number;
  stack?: number;
  onClick: (v: number) => void;
}) {
  const { label, mult, pot, stack, bb, onClick } = props;
  const value =
    typeof stack === "number"
      ? stack
      : typeof pot === "number"
      ? pot
      : typeof mult === "number"
      ? mult * bb
      : bb;
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      className="text-xs rounded border border-white/10 px-2 py-1 hover:border-accent"
      title={
        typeof stack === "number"
          ? "All-in"
          : typeof pot === "number"
          ? "Pot"
          : `${mult}× BB`
      }
    >
      {label}
    </button>
  );
}
