import React, { useEffect, useMemo, useRef, useState } from "react";
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

/** ---------- Config ---------- */
const MIN_INTER_HAND_MS = 8000; // client-side minimum pause between hands

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
  | {
      type: "SHOWDOWN";
      hands?: Array<{
        seatNo: number;
        cards?: [[Rank, Suit], [Rank, Suit]];
        hole?: [[Rank, Suit], [Rank, Suit]];
        folded?: boolean;
      }>;
      pots?: any;
    }
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

/** Display ranks (A K Q J 10 …) for the Card component */
const DISPLAY_RANK: Record<number, string> = {
  14: "A",
  13: "K",
  12: "Q",
  11: "J",
};
function displayRank(r: number): string {
  return DISPLAY_RANK[r] ?? String(r);
}

/** Hand label helper: TYPE ONLY (no ranks) */
function labelBestHand(
  hole?: [[Rank, Suit], [Rank, Suit]],
  board?: [Rank, Suit][]
) {
  if (!hole || hole.length !== 2) return "";
  const cards = [...hole, ...(board ?? [])];
  const ranks = cards.map((c) => c[0]);
  const suits = cards.map((c) => c[1]);

  const rc: Record<number, number> = {};
  for (const r of ranks) rc[r] = (rc[r] || 0) + 1;
  const sc: Record<string, number> = {};
  for (const s of suits) sc[s] = (sc[s] || 0) + 1;

  const isFlush = Object.values(sc).some((v) => v >= 5);

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

  const counts = Object.values(rc);
  const pairs = counts.filter((c) => c === 2).length;
  const trips = counts.filter((c) => c === 3).length;
  const quads = counts.filter((c) => c === 4).length;

  if (isFlush && straightHigh) return "Straight Flush";
  if (quads) return "Four of a Kind";
  if (trips && (trips >= 2 || pairs)) return "Full House";
  if (isFlush) return "Flush";
  if (straightHigh) return "Straight";
  if (trips) return "Three of a Kind";
  if (pairs >= 2) return "Two Pair";
  if (pairs === 1) return "One Pair";
  return "High Card";
}

/** Determine best-five selection for highlighting */
function pickBestFive(
  hole?: [[Rank, Suit], [Rank, Suit]],
  board?: [Rank, Suit][]
): {
  hand: string;
  boardIdx: number[];
  holeMask: [boolean, boolean];
} {
  const handName = labelBestHand(hole, board);
  if (!hole || !board || board.length === 0) {
    return { hand: handName, boardIdx: [], holeMask: [false, false] };
  }

  type Src = { rank: Rank; suit: Suit; src: "B" | "H"; idx: number };
  const bList: Src[] = board.map((c, i) => ({ rank: c[0], suit: c[1], src: "B", idx: i }));
  const hList: Src[] = hole.map((c, i) => ({ rank: c[0], suit: c[1], src: "H", idx: i })) as Src[];
  const all: Src[] = [...bList, ...hList];

  const byRank = new Map<number, Src[]>();
  for (const c of all) {
    if (!byRank.has(c.rank)) byRank.set(c.rank, []);
    byRank.get(c.rank)!.push(c);
  }

  const bySuit = new Map<Suit, Src[]>();
  for (const c of all) {
    if (!bySuit.has(c.suit)) bySuit.set(c.suit, []);
    bySuit.get(c.suit)!.push(c);
  }

  const resultB = new Set<number>();
  const resultH = new Set<number>();
  const take = (c: Src) => {
    if (c.src === "B") resultB.add(c.idx);
    else resultH.add(c.idx);
  };

  const sortedRanksDesc = Array.from(new Set(all.map((c) => c.rank))).sort((a, b) => b - a);

  function straightFrom(cards: Src[]): Src[] | null {
    const uniqRanks = Array.from(new Set(cards.map((c) => c.rank))).sort((a, b) => b - a);
    const withWheel = uniqRanks.includes(14) ? [...uniqRanks, 1] : uniqRanks;
    let run: number[] = [];
    let best: number[] | null = null;
    for (let i = 0; i < withWheel.length; i++) {
      if (i === 0 || withWheel[i] === withWheel[i - 1] - 1) {
        run.push(withWheel[i]);
      } else {
        run = [withWheel[i]];
      }
      if (run.length >= 5) {
        best = run.slice(run.length - 5);
        break;
      }
    }
    if (!best) return null;
    const out: Src[] = [];
    for (let ri = 0; ri < best.length; ri++) {
      const want = best[ri] === 1 ? 14 : best[ri];
      const candidates = cards.filter((c) => c.rank === want);
      const pick =
        candidates.find((c) => c.src === "H" && !out.includes(c)) ||
        candidates.find((c) => !out.includes(c));
      if (pick) out.push(pick);
    }
    return out.length === 5 ? out : null;
  }

  const flushSuitEntry = Array.from(bySuit.entries()).find(([, arr]) => arr.length >= 5);
  const flushCards = flushSuitEntry ? flushSuitEntry[1].slice().sort((a, b) => b.rank - a.rank) : null;
  const straightCards = straightFrom(all);
  const straightFlushCards = flushCards ? straightFrom(flushCards) : null;

  const rankCounts = sortedRanksDesc.map((r) => ({
    rank: r,
    count: byRank.get(r)?.length ?? 0,
  }));
  const quads = rankCounts.find((x) => x.count === 4);
  const tripsAll = rankCounts.filter((x) => x.count === 3);
  const pairsAll = rankCounts.filter((x) => x.count === 2);

  const handNameCase = handName;
  switch (handNameCase) {
    case "Straight Flush":
      if (straightFlushCards) straightFlushCards.forEach(take);
      break;
    case "Four of a Kind":
      if (quads) byRank.get(quads.rank)!.forEach(take);
      break;
    case "Full House": {
      const trips = tripsAll[0];
      const pair = tripsAll.length > 1 ? tripsAll[1] : pairsAll[0];
      if (trips) byRank.get(trips.rank)!.slice(0, 3).forEach(take);
      if (pair) byRank.get(pair.rank)!.slice(0, 2).forEach(take);
      break;
    }
    case "Flush":
      if (flushCards) flushCards.slice(0, 5).forEach(take);
      break;
    case "Straight":
      if (straightCards) straightCards.forEach(take);
      break;
    case "Three of a Kind":
      if (tripsAll[0]) byRank.get(tripsAll[0].rank)!.slice(0, 3).forEach(take);
      break;
    case "Two Pair": {
      const p1 = pairsAll[0];
      const p2 = pairsAll[1];
      if (p1) byRank.get(p1.rank)!.slice(0, 2).forEach(take);
      if (p2) byRank.get(p2.rank)!.slice(0, 2).forEach(take);
      break;
    }
    case "One Pair":
      if (pairsAll[0]) byRank.get(pairsAll[0].rank)!.slice(0, 2).forEach(take);
      break;
    default:
      // High card: prefer highlighting hole cards
      board?.length;
      hList.forEach(take);
      break;
  }

  return {
    hand: handName,
    boardIdx: Array.from(resultB.values()).sort((a, b) => a - b),
    holeMask: [resultH.has(0), resultH.has(1)],
  };
}

/** If the best hand is a Flush / Straight Flush, return the suit used */
function detectFlushSuit(
  hole?: [[Rank, Suit], [Rank, Suit]],
  board?: [Rank, Suit][]
): Suit | null {
  if (!hole || !board) return null;
  const suits = [...hole, ...board].map((c) => c[1]);
  const counts: Record<Suit, number> = { S: 0, H: 0, D: 0, C: 0 };
  suits.forEach((s) => (counts[s] += 1));
  const suit = (["S", "H", "D", "C"] as Suit[]).find((s) => counts[s] >= 5) ?? null;
  if (!suit) return null;
  const type = labelBestHand(hole, board);
  return type === "Flush" || type === "Straight Flush" ? suit : null;
}

/** CSS conic-gradient timer ring */
function ringStyle(deg: number): React.CSSProperties {
  const s: any = {
    background: `conic-gradient(from -90deg, var(--accent, #22d3ee) ${deg}deg, transparent 0)`,
    WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
    mask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)",
    WebkitMaskComposite: "xor",
    padding: "6px",
  };
  s.maskComposite = "exclude";
  return s;
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

/** ---------- Showdown state ---------- */
type ShowdownState = {
  revealed: Record<number, [[Rank, Suit], [Rank, Suit]]>; // seatNo -> hole (visible by default)
  folded: Record<number, [[Rank, Suit], [Rank, Suit]]>; // seatNo -> hole (folded; hidden by default)
  winners: { seatNo: number; amount: number }[];
  awards: { seatNo: number; amount: number; potIndex?: number }[];
  board: [Rank, Suit][];
  pot: number;
  until: number | null;
};

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

  // Felt size for responsive seat placement
  const feltRef = useRef<HTMLDivElement | null>(null);
  const [feltSize, setFeltSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!feltRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const cr = entry.contentRect;
        setFeltSize({ w: cr.width, h: cr.height });
      }
    });
    ro.observe(feltRef.current);
    return () => ro.disconnect();
  }, []);

  // Betting controls and countdown
  const [actionSeat, setActionSeat] = useState<number | null>(null);
  const [toCall, setToCall] = useState<number>(0); // cents
  const [minRaise, setMinRaise] = useState<number>(0); // cents
  const [deadline, setDeadline] = useState<number | null>(null); // epoch ms
  const [turnTotalMs, setTurnTotalMs] = useState<number>(0); // total ms for ring
  const [betInput, setBetInput] = useState<string>(""); // dollars string
  const [countdownNow, setCountdownNow] = useState<number>(Date.now());

  // Inter-hand pause display
  const [interWaitUntil, setInterWaitUntil] = useState<number | null>(null);

  // Winner flash
  const [winnerFlash, setWinnerFlash] = useState<Record<number, number>>({}); // seatNo -> untilTs

  // Per-seat last action tags
  const [lastActions, setLastActions] = useState<Record<
    number,
    { text: string; until: number }
  >>({});

  // Lock actions during board reveals
  const [revealLocked, setRevealLocked] = useState(false);

  // Showdown (post-hand view)
  const [showdown, setShowdown] = useState<ShowdownState | null>(null);

  // Aggregate winners as POT_AWARDED arrives
  const winnersAggRef = useRef<Record<number, number>>({});

  // Track if any hand has started (for Start Game button)
  const [hasAnyHandStarted, setHasAnyHandStarted] = useState(false);

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
      // Prefer manual start if server supports it
      try {
        socket.send(JSON.stringify({ type: "SET_AUTOSTART", value: false }));
      } catch {}
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
      setTurnTotalMs(0);
      setInterWaitUntil(null);
      setBoardWriter("snapshot");
      dealQRef.current = [];
      handIdRef.current = null;
      setShowdown(null);
      winnersAggRef.current = {};
      setHasAnyHandStarted(false);
      setShowFoldedMap({});
    };
  }

  /** ---------- Board writer model + reveal queue ---------- */

  type CardT = [Rank, Suit];
  type DealJob =
    | { kind: "flop"; cards: CardT[]; handId: number }
    | { kind: "turn" | "river"; card: CardT; handId: number };

  const handIdRef = useRef<number | null>(null);

  // Only one writer mutates board during a live hand.
  const [boardWriter, setBoardWriter] = useState<"events" | "snapshot">("snapshot");

  const dealQRef = useRef<DealJob[]>([]);
  const dealRunningRef = useRef(false);

  function enqueueDeal(job: DealJob) {
    dealQRef.current.push(job);
    if (!dealRunningRef.current) runDealWorker();
  }

  function wait(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  async function runDealWorker() {
    dealRunningRef.current = true;
    try {
      while (dealQRef.current.length) {
        const job = dealQRef.current.shift()!;
        if (handIdRef.current !== job.handId) continue;

        setRevealLocked(true);
        setActionSeat(null);
        setDeadline(null);
        setTurnTotalMs(0);

        if (job.kind === "flop") {
          setHand((prev) => (prev ? { ...prev, board: [], stage: "flop" } : prev));
          for (let i = 0; i < job.cards.length; i++) {
            await wait(i === 0 ? 120 : 140);
            const c = job.cards[i];
            setHand((prev) =>
              prev
                ? {
                    ...prev,
                    board:
                      prev.board.length >= 3
                        ? prev.board.slice(0, 3)
                        : [...prev.board, c],
                  }
                : prev
            );
          }
        } else if (job.kind === "turn") {
          await wait(180);
          setHand((prev) =>
            prev
              ? {
                  ...prev,
                  stage: "turn",
                  board: prev.board.slice(0, 3).concat([job.card]),
                }
              : prev
          );
        } else {
          await wait(180);
          setHand((prev) =>
            prev
              ? {
                  ...prev,
                  stage: "river",
                  board: prev.board.slice(0, 4).concat([job.card]),
                }
              : prev
          );
        }

        await wait(80);
        setRevealLocked(false);
      }
    } finally {
      dealRunningRef.current = false;
    }
  }

  /** ---------- WS Dispatcher ---------- */

  function handleWsEvent(msg: WsEvent) {
    switch (msg.type) {
      case "TABLE_SNAPSHOT": {
        const { table, seats, hand: snapHand } = msg.state;

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
          status: snapHand ? "running" : "waiting",
        }));
        setSeats(seats);

        if (snapHand) {
          const changed = handIdRef.current == null || handIdRef.current !== snapHand.handId;
          if (changed) {
            handIdRef.current = snapHand.handId;
            setBoardWriter("snapshot");
            dealQRef.current = [];
            setShowdown(null);
            winnersAggRef.current = {};
            setShowFoldedMap({});
          }
        }

        setHand((prev) => {
          if (!snapHand) return prev;
          const board =
            boardWriter === "snapshot" ? snapHand.board : (prev?.board ?? snapHand.board);
          return { ...snapHand, board };
        });

        const mine = seats.find((s) => sameId(s.user_id, me?.id));
        setMySeat(mine ? mine.seat_no : null);
        mySeatRef.current = mine ? mine.seat_no : null;

        if (snapHand?.toAct != null && boardWriter === "snapshot") {
          setActionSeat(snapHand.toAct);
        }

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
        const p = hand?.players?.find((x) => x.seatNo === msg.seatNo);
        if (p && (p.hasFolded || p.isAllIn)) {
          setActionSeat(null);
          setDeadline(null);
          setTurnTotalMs(0);
          break;
        }

        setActionSeat(msg.seatNo);
        setMinRaise(msg.minRaise);
        setToCall(msg.toCall);
        const ttl = msg.timeLeftMs || 0;
        setDeadline(Date.now() + ttl);
        setTurnTotalMs(ttl);

        const cb = hand?.curBet ?? 0;
        const target = Math.max(cb + msg.minRaise, cb);
        setBetInput((target / 100).toFixed(2));
        break;
      }

      case "PLAYER_ACTION_APPLIED": {
        const text =
          msg.action === "fold"
            ? "Fold"
            : msg.action === "check"
            ? "Check"
            : msg.action === "call"
            ? `Call $${dollars(msg.amount)}`
            : msg.action === "bet"
            ? `Bet $${dollars(msg.amount)}`
            : `Raise $${dollars(msg.amount)}`;
        setLastActions((prev) => ({
          ...prev,
          [msg.seatNo]: { text, until: Date.now() + 2000 },
        }));

        setHand((prev) =>
          prev
            ? {
                ...prev,
                players: prev.players.map((p) =>
                  p.seatNo === msg.seatNo
                    ? {
                        ...p,
                        streetBet:
                          msg.action === "fold" ? p.streetBet : p.streetBet + msg.amount,
                        totalContrib: p.totalContrib + msg.amount,
                        hasFolded: msg.action === "fold" ? true : p.hasFolded,
                      }
                    : p
                ),
              }
            : prev
        );

        setActionSeat(null);
        setDeadline(null);
        setTurnTotalMs(0);

        break;
      }

      case "HAND_STARTED": {
        setBoardWriter("events");
        dealQRef.current = [];
        setRevealLocked(false);
        setLastActions({});
        setWinnerFlash({});
        setShowdown(null);
        winnersAggRef.current = {};
        setHasAnyHandStarted(true);
        setShowFoldedMap({});

        setHand((prev) =>
          prev
            ? {
                ...prev,
                handId: msg.handId,
                dealerSeat: msg.dealerSeat,
                smallBlindSeat: msg.smallBlindSeat,
                bigBlindSeat: msg.bigBlindSeat,
                deckCommit: msg.deckCommit,
                board: [],
                pot: 0,
                stage: "preflop",
                curBet: 0,
                minRaise: 0,
                players: (prev.players ?? []).map((p) => ({
                  ...p,
                  streetBet: 0,
                  hasFolded: false,
                  isAllIn: false,
                })),
              }
            : prev
        );
        handIdRef.current = msg.handId;
        break;
      }

      case "DEAL_FLOP": {
        if (boardWriter !== "events" || !handIdRef.current) break;
        setActionSeat(null);
        setDeadline(null);
        setTurnTotalMs(0);
        enqueueDeal({ kind: "flop", cards: msg.cards, handId: handIdRef.current });
        break;
      }

      case "DEAL_TURN": {
        if (boardWriter !== "events" || !handIdRef.current) break;
        setActionSeat(null);
        setDeadline(null);
        setTurnTotalMs(0);
        enqueueDeal({ kind: "turn", card: msg.card, handId: handIdRef.current });
        break;
      }

      case "DEAL_RIVER": {
        if (boardWriter !== "events" || !handIdRef.current) break;
        setActionSeat(null);
        setDeadline(null);
        setTurnTotalMs(0);
        enqueueDeal({ kind: "river", card: msg.card, handId: handIdRef.current });
        break;
      }

      case "SHOWDOWN": {
        // Build revealed and folded maps
        const revealed: Record<number, [[Rank, Suit], [Rank, Suit]]> = {};
        const folded: Record<number, [[Rank, Suit], [Rank, Suit]]> = {};
        if (Array.isArray(msg.hands)) {
          for (const h of msg.hands) {
            const seatNo = (h as any).seatNo;
            const isFolded = (h as any).folded === true;
            const cards = (h as any).cards ?? (h as any).hole ?? null;
            if (
              typeof seatNo === "number" &&
              Array.isArray(cards) &&
              cards.length === 2 &&
              Array.isArray(cards[0]) &&
              Array.isArray(cards[1])
            ) {
              if (isFolded) folded[seatNo] = cards as [[Rank, Suit], [Rank, Suit]];
              else revealed[seatNo] = cards as [[Rank, Suit], [Rank, Suit]];
            }
          }
        }

        setShowdown((prev) => ({
          revealed: { ...(prev?.revealed ?? {}), ...revealed },
          folded: { ...(prev?.folded ?? {}), ...folded },
          winners: prev?.winners ?? [],
          awards: prev?.awards ?? [],
          board: hand?.board ?? prev?.board ?? [],
          pot: hand?.pot ?? prev?.pot ?? 0,
          until: prev?.until ?? null,
        }));

        const atLeast = Date.now() + MIN_INTER_HAND_MS;
        setInterWaitUntil((cur) => (!cur ? atLeast : Math.max(cur, atLeast)));

        setActionSeat(null);
        setDeadline(null);
        setTurnTotalMs(0);
        break;
      }

      case "POT_AWARDED": {
        winnersAggRef.current[msg.seatNo] =
          (winnersAggRef.current[msg.seatNo] ?? 0) + msg.amount;

        setShowdown((prev) => {
          const prevW = prev?.winners ?? [];
          const idx = prevW.findIndex((w) => w.seatNo === msg.seatNo);
          const nextW =
            idx >= 0
              ? prevW.map((w, i) =>
                  i === idx ? { seatNo: w.seatNo, amount: w.amount + msg.amount } : w
                )
              : prevW.concat({ seatNo: msg.seatNo, amount: msg.amount });

          const nextAwards = (prev?.awards ?? []).concat({
            seatNo: msg.seatNo,
            amount: msg.amount,
            potIndex: msg.potIndex,
          });

          return {
            revealed: prev?.revealed ?? {},
            folded: prev?.folded ?? {},
            winners: nextW,
            awards: nextAwards,
            board: hand?.board ?? prev?.board ?? [],
            pot: hand?.pot ?? prev?.pot ?? 0,
            until: prev?.until ?? null,
          };
        });

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
        setBoardWriter("snapshot");
        dealQRef.current = [];
        setRevealLocked(false);

        const wait = Math.max(MIN_INTER_HAND_MS, msg.waitMs ?? 0);
        setInterWaitUntil(Date.now() + wait);

        setActionSeat(null);
        setDeadline(null);
        setTurnTotalMs(0);
        break;
      }

      case "CASH_OUT_OK": {
        try {
          const target = getNavBalanceTarget();
          const src = mySeat != null ? seatRefs.current[mySeat] : null;
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
    const dollarsNum = Number(sitDollars || "0");
    const amountCents = Math.max(0, Math.round(dollarsNum * 100));

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

  const potCents = hand?.pot ?? showdown?.pot ?? 0;

  // ------- Betting UI helpers -------

  const isMyTurn =
    actionSeat != null && mySeat != null && actionSeat === mySeat;

  const myCanAct =
    isMyTurn &&
    myPlayer &&
    !myPlayer.hasFolded &&
    !myPlayer.isAllIn &&
    !revealLocked;

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

  // countdown 0..1 used (accurate now)
  const countdownUsed = useMemo(() => {
    if (!deadline || !turnTotalMs) return 0;
    const msLeft = Math.max(0, deadline - countdownNow);
    const used = 1 - msLeft / Math.max(1, turnTotalMs);
    return Math.max(0, Math.min(1, used));
  }, [deadline, turnTotalMs, countdownNow]);

  // inter-hand seconds left
  const interLeft = useMemo(() => {
    if (!interWaitUntil) return 0;
    return Math.max(0, Math.ceil((interWaitUntil - Date.now()) / 1000));
  }, [interWaitUntil, countdownNow]);

  // Hand label for me (TYPE ONLY)
  const myHandLabel = useMemo(
    () => labelBestHand(hand?.myHole, hand?.board),
    [hand?.myHole, hand?.board]
  );

  // ------- Layout helpers -------

  // Precompute seat positions anchored to felt center using ellipse
  const seatPositions = useMemo(() => {
    const count = selected?.maxSeats || seats.length || 6;
    const w = feltSize.w || 720;
    const h = feltSize.h || 640;

    const centerX = w / 2;
    const centerY = h * 0.54;

    let radiusX = w * 0.42;
    let radiusY = h * 0.44;

    if (h < 460) radiusY *= 0.92;

    const list: { left: number; top: number; angle: number }[] = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      let left = centerX + radiusX * Math.cos(angle);
      let top = centerY + radiusY * Math.sin(angle);

      if (Math.sin(angle) < 0) top -= h * 0.04;

      const s = Math.sin(angle);
      if (s > 0.60) top -= h * 0.10;
      else if (s > 0.20) top -= h * 0.07;

      const safeTop = h * 0.14;
      const safeBottom = h * 0.18;
      if (top < safeTop) top = safeTop + 16;
      if (top > h - safeBottom) top = h - safeBottom;

      const padX = 88;
      left = Math.max(padX, Math.min(w - padX, left));

      list.push({ left, top, angle });
    }
    return list;
  }, [selected?.maxSeats, seats.length, feltSize]);

  function winnerGlowClass(seatNo: number) {
    const until = winnerFlash[seatNo] || 0;
    return until > Date.now()
      ? "ring-2 ring-green-400 shadow-[0_0_20px_rgba(34,197,94,0.45)]"
      : "";
  }

  /** Seat helper */
  const seatName = (seatNo: number) =>
    seats.find((s) => s.seat_no === seatNo)?.username || `Seat ${seatNo}`;

  /** Determine winning seats set (handles side pots via awards when present) */
  const winnerSeatSet = useMemo(() => {
    const set = new Set<number>();
    if (!showdown) return set;
    const source =
      showdown.awards && showdown.awards.length > 0
        ? showdown.awards
        : showdown.winners;
    source.forEach((w) => set.add(w.seatNo));
    return set;
  }, [showdown]);

  /** Winner summary text lines */
  const winnerSummaryLines = useMemo(() => {
    if (!showdown) return [];
    const board = showdown.board;
    const linesSource =
      showdown.awards && showdown.awards.length > 0
        ? showdown.awards
        : showdown.winners.map((w) => ({
            seatNo: w.seatNo,
            amount: w.amount,
            potIndex: undefined as number | undefined,
          }));

    return linesSource.map((w) => {
      const hole = showdown.revealed[w.seatNo];
      const handTxt = hole ? labelBestHand(hole, board) : "";
      const potLabel =
        w.potIndex == null
          ? ""
          : w.potIndex === 0
          ? " — Main pot"
          : ` — Side pot #${w.potIndex}`;
      return `${seatName(w.seatNo)} wins $${dollars(w.amount)}${
        handTxt ? ` with ${handTxt}` : ""
      }${potLabel}`;
    });
  }, [showdown, seats]);

  /** Board highlight: union across winners.
      If a winner has a flush, highlight ALL board cards of that suit. Otherwise, highlight best 5 indices. */
  const boardHighlightSet = useMemo(() => {
    const set = new Set<number>();
    if (!showdown || !showdown.board?.length) return set;

    const seatsToShow =
      showdown.awards && showdown.awards.length > 0
        ? showdown.awards.map((a) => a.seatNo)
        : showdown.winners.map((a) => a.seatNo);

    for (const sNo of seatsToShow) {
      const hole = showdown.revealed[sNo];
      if (!hole) continue;
      const flushSuit = detectFlushSuit(hole, showdown.board);
      if (flushSuit) {
        showdown.board.forEach((c, idx) => {
          if (c[1] === flushSuit) set.add(idx);
        });
      } else {
        const sel = pickBestFive(hole, showdown.board);
        sel.boardIdx.forEach((idx) => set.add(idx));
      }
    }
    return set;
  }, [showdown]);

  // ------- Render -------

  // Start-game button visibility: first hand only, at least 2 seated, connected
  const seatedCount = seats.filter((s) => !!s.user_id).length;
  const showStartGame = !!ws && !hasAnyHandStarted && seatedCount >= 2;

  const startGame = () => {
    sendWs({ type: "START_GAME" });
  };

  // Slider safe bounds
  const minSlider = (hand?.curBet ?? 0) === 0 ? minRaise : (hand?.curBet ?? 0) + minRaise;
  const maxSlider = Math.max(minSlider, myStackApprox);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6">
      {/* Left: Table */}
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

        {/* Felt */}
        <div
          ref={feltRef}
          className="relative h-[640px] lg:h-[720px] rounded-2xl bg-gradient-to-b from-emerald-900/40 to-emerald-800/30 border border-white/10 overflow-hidden"
        >
          {/* Start Game (first hand only) */}
          {showStartGame && (
            <div className="absolute top-3 right-3 z-10">
              <Button onClick={startGame} className="px-3 py-1">
                Start Game
              </Button>
            </div>
          )}

          {ws && (
            <>
              {/* Inter-hand overlay */}
              {interWaitUntil && interLeft > 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-start pt-2 pointer-events-none">
                  <div className="rounded-full bg-white/10 px-3 py-1 text-sm text-white/80 border border-white/15">
                    Next round begins in {interLeft}s
                  </div>
                </div>
              )}

              {/* Pot cluster */}
              <div
                ref={potRef}
                className="absolute left-1/2 top-[25%] -translate-x-1/2 -translate-y-1/2 flex flex-col items-center"
              >
                <div className="text-xs text-white/70">Pot</div>
                <ChipStack amountCents={potCents} chipSize={28} />
                <div className="text-white/80 text-sm mt-1">
                  ${dollars(potCents)}
                </div>
              </div>

              {/* Board cards (persist after hand) */}
              <div className="absolute left-1/2 top-[35%] -translate-x-1/2 flex gap-2">
                {(hand?.board ?? showdown?.board ?? []).map((c, i, arr) => {
                  const highlight = boardHighlightSet.has(i);
                  return (
                    <div
                      key={`${c[0]}${c[1]}-${i}`}
                      className={[
                        i === arr.length - 1 ? "animate-[fadeIn_240ms_ease-out]" : "",
                        highlight
                          ? "rounded-md ring-2 ring-yellow-300 shadow-[0_0_18px_rgba(250,204,21,0.6)]"
                          : "",
                      ].join(" ")}
                    >
                      <Card rank={displayRank(c[0])} suit={c[1]} />
                    </div>
                  );
                })}
              </div>

              {/* Winner summary */}
              {winnerSummaryLines.length > 0 && (
                <div className="absolute left-1/2 top-[53%] -translate-x-1/2 text-center px-3">
                  <div className="inline-flex flex-col gap-1 bg-black/30 border border-white/10 rounded-md px-3 py-2">
                    {winnerSummaryLines.map((line, idx) => (
                      <div key={idx} className="text-white/85 text-sm">
                        {line}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Seats */}
              {seats.map((s, idx) => {
                const seatIndex = s.seat_no ?? idx;
                const pos =
                  seatPositions[seatIndex] || { left: 360, top: 300, angle: 0 };
                const isMe = sameId(s.user_id, me?.id);
                const pub = playersBySeat.get(seatIndex);
                const actingThisSeat =
                  actionSeat === seatIndex && pub && !pub.hasFolded && !pub.isAllIn;
                const didFold = !!pub?.hasFolded || (!!showdown && !!showdown.folded[seatIndex]);

                const progressRemaining = actingThisSeat
                  ? Math.max(0, 1 - countdownUsed)
                  : 0;
                const degrees = Math.round(progressRemaining * 360);

                // Determine which hole to show:
                // - If not folded and showdown present, reveal from showdown map
                // - If mine and during hand, show myHole
                // - If folded and user toggled, show folded cards (if provided by server)
                let showHole: [[Rank, Suit], [Rank, Suit]] | null = null;
                if (showdown) {
                  if (showdown.revealed[seatIndex]) {
                    showHole = showdown.revealed[seatIndex];
                  } else if (didFold && isMe && showdown.folded[seatIndex]) {
                    showHole = showdown.folded[seatIndex];
                  }
                }
                if (!showdown && isMe && hand?.myHole && hand.myHole.length === 2) {
                  showHole = hand.myHole;
                }

                // Highlighting of winners only
                let holeHL: [boolean, boolean] = [false, false];
                if (
                  showdown &&
                  showHole &&
                  winnerSeatSet.has(seatIndex) &&
                  showdown.board?.length
                ) {
                  // If the winner's best hand is a flush, highlight all cards of that suit
                  const flushSuit = detectFlushSuit(showHole, showdown.board);
                  if (flushSuit) {
                    holeHL = [
                      showHole[0][1] === flushSuit,
                      showHole[1][1] === flushSuit,
                    ];
                  } else {
                    const sel = pickBestFive(showHole, showdown.board);
                    holeHL = sel.holeMask;
                  }
                }

                const isWinner = showdown ? winnerSeatSet.has(seatIndex) : false;

                return (
                  <div
                    key={seatIndex}
                    ref={(el) => (seatRefs.current[seatIndex] = el)}
                    className="absolute -translate-x-1/2 -translate-y-1/2 w-[176px]"
                    style={{ left: pos.left, top: pos.top }}
                  >
                    <div
                      className={[
                        "relative rounded-[12px] border bg-black/30 px-3 py-2",
                        isMe ? "border-accent" : "border-white/10",
                        pub?.isAllIn ? "ring-1 ring-yellow-400/60" : "",
                        didFold ? "opacity-60" : "",
                        actingThisSeat
                          ? "shadow-[0_0_24px_rgba(34,211,238,0.25)]"
                          : "",
                        isWinner ? winnerGlowClass(seatIndex) : "",
                      ].join(" ")}
                    >
                      {/* CSS conic-gradient border timer */}
                      {actingThisSeat && (
                        <div
                          className="pointer-events-none absolute -inset-[6px] rounded-[14px]"
                          style={ringStyle(degrees)}
                        />
                      )}

                      {/* Dealer pip */}
                      {hand?.dealerSeat === seatIndex && (
                        <div className="absolute -left-2 -top-2 w-5 h-5 grid place-items-center rounded-full bg-white text-black text-[10px] font-bold shadow-sm">
                          D
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        <div className="text-sm font-semibold truncate">
                          {s.username || "Empty"}
                        </div>
                      </div>

                      {/* chips, stack */}
                      <div className="mt-1">
                        <ChipStack amountCents={s.stack} chipSize={18} />
                      </div>
                      <div className="text-xs text-white/70 mt-0.5">
                        {(s.stack / 100).toFixed(2)}
                      </div>

                      {/* Hole cards */}
                      <div className="mt-1 flex items-center gap-1">
                        {showHole ? (
                          <>
                            <div
                              className={
                                holeHL[0]
                                  ? "rounded-md ring-2 ring-yellow-300 shadow-[0_0_14px_rgba(250,204,21,0.55)]"
                                  : ""
                              }
                            >
                              <Card
                                rank={displayRank(showHole[0][0])}
                                suit={showHole[0][1]}
                              />
                            </div>
                            <div
                              className={
                                holeHL[1]
                                  ? "rounded-md ring-2 ring-yellow-300 shadow-[0_0_14px_rgba(250,204,21,0.55)]"
                                  : ""
                              }
                            >
                              <Card
                                rank={displayRank(showHole[1][0])}
                                suit={showHole[1][1]}
                              />
                            </div>
                            {didFold && (
                              <span className="ml-1 text-[10px] rounded px-1 py-0.5 bg-white/10 border border-white/10">
                                Folded
                              </span>
                            )}
                          </>
                        ) : pub ? (
                          <>
                            <Card rank={""} suit={"S"} faceDown />
                            <Card rank={""} suit={"S"} faceDown />
                          </>
                        ) : null}
                      </div>

                      {/* Folded-hand toggle (only after showdown and if server provided cards) */}
                      {showdown && didFold && isMe && showdown.folded[seatIndex] && !showdown.revealed[seatIndex] && (
                        <div className="mt-2">
                          <button
                            onClick={() => sendWs({ type: "SHOW_HAND" })}
                            className="text-[11px] rounded border border-white/10 px-2 py-0.5 hover:border-accent"
                            title="Reveal folded hand to table"
                          >
                            Show hand
                          </button>
                        </div>
                      )}

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
      </div>

      {/* Right: Lobby + Betting controls */}
      <div className="flex flex-col gap-4">
        {/* Lobby (fixed height with scroll) */}
        <div className="rounded-2xl bg-card border border-white/10 p-4 h-[320px] flex flex-col">
          <div className="text-white/70 text-sm">Table Lobby</div>
          <div className="mt-2 space-y-2 overflow-y-auto pr-1">
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

        {/* Betting controls */}
        <div className="rounded-2xl bg-card border border-white/10 p-4">
          <div className="text-base font-semibold text-white/90 mb-2">
            Betting Controls
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm text-white/70">
              {actionSeat != null ? `To act: Seat ${actionSeat}` : "Waiting…"}
              {isMyTurn && deadline
                ? ` • ${Math.max(0, Math.ceil((deadline - countdownNow) / 1000))}s`
                : ""}
            </div>
            <div className="ml-auto text-xs text-white/60">
              {isMyTurn ? (
                <>
                  To call: ${dollars(toCall)} • Min raise: ${dollars(minRaise)} •
                  Current bet: ${dollars(hand?.curBet ?? 0)}
                </>
              ) : null}
            </div>
          </div>

          {/* My hand helper (type only) */}
          {hand?.myHole && (
            <div className="mt-2 text-sm text-white/80">
              Your hand:{" "}
              <span className="font-semibold text-white">{myHandLabel}</span>
            </div>
          )}

          {/* Primary action row */}
          <div className="mt-3 flex flex-wrap gap-2">
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
              Call ${dollars(toCall)}
            </Button>
            <Button
              onClick={() => sendPlayerAction(toCall > 0 ? "fold" : "check")}
              disabled={!myCanAct}
              className="px-3 py-1"
              title="Checks when free, folds when there's a bet"
            >
              Check/Fold
            </Button>
          </div>

          {/* Bet/Raise row — dedicated line to avoid wrap */}
          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <input
              type="range"
              min={minSlider}
              max={maxSlider}
              step={100}
              value={Math.min(
                Math.max(minSlider, Math.round(Number(betInput || "0") * 100)),
                maxSlider
              )}
              onChange={(e) =>
                setBetInput((Number(e.target.value) / 100).toFixed(2))
              }
              className="w-56"
              disabled={!myCanAct}
            />
            <span className="text-sm text-white/80">
              ${betInput || "0.00"}
            </span>
            {(hand?.curBet ?? 0) === 0 ? (
              <Button
                onClick={() => {
                  const toTotal = Math.round(Number(betInput || "0") * 100);
                  if (!Number.isFinite(toTotal) || toTotal < minRaise) return;
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
          <div className="mt-3 flex items-center gap-2">
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
              label="1/2 Pot"
              pot={(hand?.pot ?? 0) / 200}
            />
            <QuickTo
              onClick={(v) => setBetInput(v.toFixed(2))}
              bb={(selected?.bigBlind ?? 100) / 100}
              label="All-in"
              stack={myStackApprox / 100}
            />
          </div>

          {/* Hints and errors */}
          {ws && !seatedMe && (
            <div className="mt-3 text-white/70">Pick a seat to start.</div>
          )}
          {error && <div className="text-danger mt-2 text-sm">{error}</div>}
        </div>
      </div>

      {/* Chip animation overlay */}
      <ChipFlightOverlay flights={flyingChips} chipSize={28} durationMs={500} />

      {/* Sit Down Modal */}
      {showSitModal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60">
          <div className="w:[360px] rounded-xl bg-card border border-white/10 p-4">
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
