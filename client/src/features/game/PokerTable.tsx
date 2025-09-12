import React, { useEffect, useState, useRef } from "react";
import { api, API_BASE } from "../../api/client";
import Button from "../../components/Button";
import Card from "../../components/Card";
import ChipStack from "../../components/ChipStack";
import { useAuthStore } from "../../store/auth";

// --------- Types ---------
type Suit = "S" | "H" | "D" | "C";
type Rank = number; // 2-14 (A=14)

type Seat = {
  seat_no: number;
  user_id?: number | string | null;
  username?: string | null;
  stack: number; // cents
  is_sitting_out: boolean;
  is_connected: boolean;
};

type PlayerInHand = {
  user_id: number;
  seat_no: number;
  hole_cards: [[Rank, Suit], [Rank, Suit]];
  has_folded: boolean;
  is_all_in: boolean;
  street_contribution: number;
  total_contribution: number;
  hand_ranking?: number[];
  winning_cards?: number[];
};

type HandResult = {
  player_seat: number;
  ranking: number[];
  hand_type: string;
  description: string;
  winning_hole_indices: number[];
  winning_board_indices: number[];
};

type Winner = {
  seat_no: number;
  amount_won: number;
  hand_result: HandResult;
  pot_index: number;
};

type HandState = {
  hand_id: number;
  dealer_seat: number;
  small_blind_seat: number;
  big_blind_seat: number;
  deck_commit: string;
  stage: "preflop" | "flop" | "turn" | "river" | "showdown";
  board: [Rank, Suit][];
  players: Record<number, PlayerInHand>;
  current_bet: number;
  minimum_raise: number;
  to_act?: number | null;
  betting_complete: boolean;
  pots: any[];
  winners: Winner[];
};

type GameState = {
  table: {
    id: string;
    name: string;
    max_seats: number;
    small_blind: number;
    big_blind: number;
    min_buy_in: number;
    max_buy_in: number;
  };
  seats: Seat[];
  hand: HandState | null;
  dealer_position: number;
  your_seat?: number;
  hole_cards?: [[Rank, Suit], [Rank, Suit]];
};

type GameEvent = {
  type: string;
  data: any;
  timestamp: number;
};

// --------- Helpers ---------
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

const DISPLAY_RANK: Record<number, string> = {
  14: "A",
  13: "K",
  12: "Q",
  11: "J",
};
function displayRank(r: number): string {
  return DISPLAY_RANK[r] ?? String(r);
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

// --------- Component ---------
export default function PokerTable() {
  const me = useAuthStore((s) => s.me);
  const fetchMe = useAuthStore((s) => s.fetchMe);
  const setMe = useAuthStore((s) => s.setMe);

  const [gameState, setGameState] = useState<GameState | null>(null);
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [showSitModal, setShowSitModal] = useState(false);
  const [pendingSeat, setPendingSeat] = useState<number | null>(null);
  const [sitDollars, setSitDollars] = useState<string>("");
  const [betAmount, setBetAmount] = useState<string>("");
  const [lastActions, setLastActions] = useState<Record<number, { text: string; until: number }>>({});

  // Animation state
  const [animatingCards, setAnimatingCards] = useState(false);
  const [winnerHighlight, setWinnerHighlight] = useState<Set<number>>(new Set());

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  useEffect(() => {
    connectToTable("main");
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  // Clear temporary action displays
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setLastActions(prev => {
        const filtered = Object.fromEntries(
          Object.entries(prev).filter(([_, action]) => action.until > now)
        );
        return Object.keys(filtered).length !== Object.keys(prev).length ? filtered : prev;
      });
    }, 500);

    return () => clearInterval(interval);
  }, []);

  function connectToTable(tableId: string) {
    if (wsRef.current) {
      wsRef.current.close();
    }

    const socket = new WebSocket(buildWsUrl(`/poker/ws/${tableId}`));
    
    socket.onopen = () => {
      setWs(socket);
      setConnected(true);
      setError(null);
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handleMessage(message);
      } catch (err) {
        console.error("Failed to parse WebSocket message:", err);
      }
    };

    socket.onclose = () => {
      setWs(null);
      setConnected(false);
      setGameState(null);
    };

    socket.onerror = () => {
      setError("Connection failed");
    };

    wsRef.current = socket;
  }

  function handleMessage(message: GameEvent | { type: "GAME_STATE"; [key: string]: any }) {
    if (message.type === "GAME_STATE") {
      // Complete state update from server
      const gameStateMessage = message as any; // Type assertion since we know it's a GAME_STATE message
      setGameState({
        table: gameStateMessage.table,
        seats: gameStateMessage.seats,
        hand: gameStateMessage.hand,
        dealer_position: gameStateMessage.dealer_position || 0,
        your_seat: gameStateMessage.your_seat,
        hole_cards: gameStateMessage.hole_cards
      });
    } else {
      // Handle game events
      handleGameEvent(message as GameEvent);
    }
  }

  function handleGameEvent(event: GameEvent) {
    switch (event.type) {
      case "HAND_STARTED":
        setAnimatingCards(true);
        setTimeout(() => setAnimatingCards(false), 1000);
        break;

      case "STREET_REVEALED":
        setAnimatingCards(true);
        setTimeout(() => setAnimatingCards(false), 500);
        break;

      case "PLAYER_ACTED":
        const { seat_no, action, amount } = event.data;
        let actionText = action;
        if (action === "call" && amount > 0) actionText = `Call $${dollars(amount)}`;
        else if (action === "bet" && amount > 0) actionText = `Bet $${dollars(amount)}`;
        else if (action === "raise" && amount > 0) actionText = `Raise $${dollars(amount)}`;
        
        setLastActions(prev => ({
          ...prev,
          [seat_no]: { text: actionText, until: Date.now() + 2000 }
        }));
        break;

      case "POT_AWARDED":
        const winner_seat = event.data.seat_no;
        setWinnerHighlight(prev => new Set(prev).add(winner_seat));
        setTimeout(() => {
          setWinnerHighlight(prev => {
            const newSet = new Set(prev);
            newSet.delete(winner_seat);
            return newSet;
          });
        }, 2000);
        break;

      case "HAND_COMPLETE":
        // Reset UI state for next hand
        setLastActions({});
        setWinnerHighlight(new Set());
        break;

      case "SEAT_TAKEN":
        // Successfully took a seat
        console.log("Successfully took seat:", event.data);
        break;

      case "SEAT_LEFT":
        // Successfully left seat
        console.log("Successfully left seat:", event.data);
        break;

      case "ERROR":
        const errorMsg = event.data?.message || "An error occurred";
        setError(errorMsg);
        // Clear error after 5 seconds
        setTimeout(() => setError(null), 5000);
        break;
    }
  }

  function sendMessage(message: any) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function sendAction(action: string, amount?: number) {
    if (!gameState?.your_seat) return;
    
    sendMessage({
      type: "PLAYER_ACTION",
      seat_no: gameState.your_seat,
      action,
      amount: amount || 0
    });
  }

  function startGame() {
    sendMessage({ type: "START_GAME" });
  }

  function takeSeat(seatNo: number) {
    setPendingSeat(seatNo);
    setSitDollars(((gameState?.table.min_buy_in ?? 0) / 100).toFixed(2));
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
      // Send seating request to server
      sendMessage({
        type: "TAKE_SEAT",
        seat_no: pendingSeat,
        buy_in_amount: amountCents
      });
      
      setShowSitModal(false);
      setPendingSeat(null);
      setError(null);
    }
  }

  function cancelSit() {
    setShowSitModal(false);
    setPendingSeat(null);
  }

  if (!connected) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <div className="text-lg mb-2">Connecting to table...</div>
          {error && <div className="text-red-500">{error}</div>}
        </div>
      </div>
    );
  }

  if (!gameState) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">Loading game state...</div>
      </div>
    );
  }

  const myPlayer = gameState.hand?.players[gameState.your_seat ?? -1];
  const isMyTurn = gameState.hand?.to_act === gameState.your_seat;
  const canAct = isMyTurn && myPlayer && !myPlayer.has_folded && !myPlayer.is_all_in;
  
  const toCall = gameState.hand && myPlayer 
    ? Math.max(0, gameState.hand.current_bet - myPlayer.street_contribution)
    : 0;

  const minRaise = gameState.hand?.minimum_raise ?? 0;
  const currentBet = gameState.hand?.current_bet ?? 0;
  
  // Calculate seat positions in a circle
  const seatPositions = Array.from({ length: gameState.table.max_seats }, (_, i) => {
    const angle = (i / gameState.table.max_seats) * 2 * Math.PI - Math.PI / 2;
    const centerX = 50;
    const centerY = 50;
    const radiusX = 35;
    const radiusY = 25;
    
    return {
      left: centerX + radiusX * Math.cos(angle),
      top: centerY + radiusY * Math.sin(angle)
    };
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6">
      {/* Game Table */}
      <div className="rounded-2xl bg-card border border-white/10 p-4">
        <div className="flex items-center justify-between mb-1">
          <div className="text-xl font-bold">Texas Hold'em</div>
          <div className="text-sm text-white/70">
            Blinds: ${dollars(gameState.table.small_blind)}/
            ${dollars(gameState.table.big_blind)}
          </div>
        </div>

        {/* Game Board */}
        <div className="relative h-[640px] lg:h-[720px] rounded-2xl bg-gradient-to-b from-emerald-900/40 to-emerald-800/30 border border-white/10 overflow-hidden">
          
          {/* Error Notification */}
          {error && (
            <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-20">
              <div className="bg-red-500/90 text-white px-4 py-2 rounded-lg border border-red-400 shadow-lg">
                {error}
              </div>
            </div>
          )}
          
          {/* Start Game Button */}
          {!gameState.hand && (
            <div className="absolute top-4 right-4 z-10">
              <Button onClick={startGame} className="px-3 py-1">
                Start Game
              </Button>
            </div>
          )}

          {/* Community Cards */}
          <div className="absolute left-1/2 top-[35%] -translate-x-1/2 flex gap-2">
            {gameState.hand?.board.map((card, i) => {
              const isWinning = gameState.hand?.winners.some(w => 
                w.hand_result.winning_board_indices.includes(i)
              );
              
              return (
                <div
                  key={`${card[0]}${card[1]}-${i}`}
                  className={`
                    ${animatingCards ? "animate-[fadeIn_500ms_ease-out]" : ""}
                    ${isWinning ? "ring-4 ring-yellow-400 shadow-[0_0_24px_rgba(250,204,21,0.8)] bg-yellow-400/10 rounded-md" : ""}
                  `}
                >
                  <Card rank={displayRank(card[0])} suit={card[1]} />
                </div>
              );
            })}
          </div>

          {/* Pot Display */}
          <div className="absolute left-1/2 top-[25%] -translate-x-1/2 -translate-y-1/2 flex flex-col items-center">
            <div className="text-xs text-white/70 mb-1">Pot</div>
            <ChipStack amountCents={gameState.hand?.pots.reduce((sum, pot) => sum + pot.amount, 0) ?? 0} chipSize={28} />
            <div className="text-white/80 text-sm mt-1">
              ${dollars(gameState.hand?.pots.reduce((sum, pot) => sum + pot.amount, 0) ?? 0)}
            </div>
          </div>

          {/* Player Seats */}
          {gameState.seats.map((seat, i) => {
            const position = seatPositions[i];
            const player = gameState.hand?.players[seat.seat_no];
            const isDealer = gameState.hand?.dealer_seat === seat.seat_no;
            const isActing = gameState.hand?.to_act === seat.seat_no;
            const isWinner = winnerHighlight.has(seat.seat_no);
            const lastAction = lastActions[seat.seat_no];
            
            // Show hole cards if it's my seat or during showdown for winners
            const showHoles = (
              (seat.seat_no === gameState.your_seat && gameState.hole_cards) ||
              (gameState.hand?.stage === "showdown" && player && !player.has_folded)
            );

            const holeCards = seat.seat_no === gameState.your_seat 
              ? gameState.hole_cards 
              : player?.hole_cards;

            return (
              <div
                key={seat.seat_no}
                className="absolute -translate-x-1/2 -translate-y-1/2"
                style={{ 
                  left: `${position.left}%`, 
                  top: `${position.top}%` 
                }}
              >
                <div className={`
                  relative rounded-lg border px-3 py-2 bg-black/30 min-w-[160px]
                  ${seat.seat_no === gameState.your_seat ? "border-accent" : "border-white/10"}
                  ${isActing ? "ring-2 ring-cyan-400 shadow-[0_0_20px_rgba(34,211,238,0.3)]" : ""}
                  ${isWinner ? "ring-2 ring-green-400 shadow-[0_0_20px_rgba(34,197,94,0.45)]" : ""}
                  ${player?.has_folded ? "opacity-60" : ""}
                `}>
                  
                  {/* Dealer Button */}
                  {isDealer && (
                    <div className="absolute -left-2 -top-2 w-5 h-5 grid place-items-center rounded-full bg-white text-black text-[10px] font-bold shadow-sm">
                      D
                    </div>
                  )}

                  {/* Player Info */}
                  <div className="text-sm font-semibold truncate">
                    {seat.username || "Empty"}
                  </div>
                  
                  {seat.user_id && (
                    <>
                      <div className="mt-1">
                        <ChipStack amountCents={seat.stack} chipSize={18} />
                      </div>
                      <div className="text-xs text-white/70">
                        ${dollars(seat.stack)}
                      </div>
                    </>
                  )}

                  {/* Hole Cards */}
                  {player && (
                    <div className="mt-2 flex gap-1">
                      {showHoles && holeCards ? (
                        holeCards.map((card, cardIndex) => {
                          const isWinningCard = gameState.hand?.winners.some(w =>
                            w.seat_no === seat.seat_no &&
                            w.hand_result.winning_hole_indices.includes(cardIndex)
                          );
                          
                          return (
                            <div
                              key={cardIndex}
                              className={isWinningCard ? "ring-4 ring-yellow-400 shadow-[0_0_20px_rgba(250,204,21,0.8)] bg-yellow-400/10 rounded-md" : ""}
                            >
                              <Card
                                rank={displayRank(card[0])}
                                suit={card[1]}
                              />
                            </div>
                          );
                        })
                      ) : (
                        <>
                          <Card rank="" suit="S" faceDown />
                          <Card rank="" suit="S" faceDown />
                        </>
                      )}
                      
                      {player.has_folded && (
                        <span className="ml-1 text-[10px] rounded px-1 py-0.5 bg-white/10 border border-white/10">
                          Folded
                        </span>
                      )}
                    </div>
                  )}

                  {/* Last Action */}
                  {lastAction && (
                    <div className="mt-1 text-[10px] text-cyan-300 capitalize">
                      {lastAction.text}
                    </div>
                  )}

                  {/* Take Seat Button */}
                  {!seat.user_id && !gameState.your_seat && (
                    <Button
                      className="mt-2 px-2 py-1 w-full text-xs"
                      onClick={() => takeSeat(seat.seat_no)}
                    >
                      Sit Here
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Controls Panel */}
      <div className="flex flex-col gap-4">
        {/* Game Status */}
        <div className="rounded-2xl bg-card border border-white/10 p-4">
          <div className="text-base font-semibold text-white/90 mb-2">
            Game Status
          </div>
          
          <div className="text-sm text-white/70 space-y-1">
            <div>Stage: {gameState.hand?.stage || "Waiting"}</div>
            {gameState.hand && (
              <>
                <div>Current Bet: ${dollars(currentBet)}</div>
                {isMyTurn && (
                  <div>To Call: ${dollars(toCall)}</div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Betting Controls */}
        <div className="rounded-2xl bg-card border border-white/10 p-4">
          <div className="text-base font-semibold text-white/90 mb-3">
            Actions
          </div>

          <div className="flex flex-wrap gap-2 mb-3">
            <Button
              onClick={() => sendAction("fold")}
              disabled={!canAct}
              className="px-3 py-1 bg-red-600 hover:bg-red-500"
            >
              Fold
            </Button>
            <Button
              onClick={() => sendAction("check")}
              disabled={!canAct || toCall > 0}
              className="px-3 py-1"
            >
              Check
            </Button>
            <Button
              onClick={() => sendAction("call")}
              disabled={!canAct || toCall === 0}
              className="px-3 py-1"
            >
              Call ${dollars(toCall)}
            </Button>
          </div>

          <div className="space-y-2">
            <input
              type="number"
              value={betAmount}
              onChange={(e) => setBetAmount(e.target.value)}
              className="w-full rounded-md bg-black/30 border border-white/10 px-2 py-1 text-white"
              placeholder="Bet amount ($)"
              disabled={!canAct}
              min="0"
              step="0.01"
            />
            
            <div className="flex gap-2">
              {currentBet === 0 ? (
                <Button
                  onClick={() => sendAction("bet", Math.round(Number(betAmount || "0") * 100))}
                  disabled={!canAct || !betAmount || Number(betAmount) < minRaise / 100}
                  className="px-3 py-1 flex-1"
                >
                  Bet
                </Button>
              ) : (
                <Button
                  onClick={() => sendAction("raise", Math.round(Number(betAmount || "0") * 100))}
                  disabled={!canAct || !betAmount || Number(betAmount) <= currentBet / 100}
                  className="px-3 py-1 flex-1"
                >
                  Raise
                </Button>
              )}
            </div>
          </div>

          {!gameState.your_seat && (
            <div className="mt-3 text-sm text-white/70">
              Take a seat to join the game
            </div>
          )}
        </div>

        {/* Hand Results */}
        {gameState.hand?.winners && gameState.hand.winners.length > 0 && (
          <div className="rounded-2xl bg-card border border-white/10 p-4">
            <div className="text-base font-semibold text-white/90 mb-2">
              Results
            </div>
            <div className="space-y-1 text-sm text-white/80">
              {gameState.hand.winners.map((winner, i) => (
                <div key={i}>
                  Seat {winner.seat_no} wins ${dollars(winner.amount_won)} with {winner.hand_result.description}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Sit Modal */}
      {showSitModal && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60">
          <div className="w-[360px] rounded-xl bg-card border border-white/10 p-4">
            <div className="text-lg font-semibold mb-2">Sit Down</div>
            <div className="text-sm text-white/70 mb-2">
              Enter buy-in amount in dollars.
            </div>
            <div className="flex items-center gap-2 mb-4">
              <span className="text-white/80">$</span>
              <input
                type="number"
                min={(gameState?.table.min_buy_in ?? 0) / 100}
                max={(gameState?.table.max_buy_in ?? 0) / 100}
                step={0.01}
                value={sitDollars}
                onChange={(e) => setSitDollars(e.target.value)}
                className="flex-1 rounded-md bg-black/30 border border-white/10 px-2 py-1 text-white"
                placeholder="0.00"
              />
            </div>
            <div className="text-xs text-white/60 mb-4">
              Min: ${dollars(gameState?.table.min_buy_in ?? 0)} • Max: ${dollars(gameState?.table.max_buy_in ?? 0)}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={cancelSit}>
                Cancel
              </Button>
              <Button
                onClick={confirmSit}
                disabled={
                  !me ||
                  Number(sitDollars || "0") <= 0 ||
                  (me?.balance_cents ?? 0) < Math.round(Number(sitDollars || "0") * 100)
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