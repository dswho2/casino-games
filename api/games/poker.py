import asyncio
import dataclasses
import hashlib
import hmac
import secrets
import time
from typing import Any, Dict, List, Optional, Set, Tuple

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..models import Transaction, User
from ..security import current_user, get_db

router = APIRouter(prefix="/poker", tags=["poker"])

# --------- Deck helpers ---------
SUITS = ["S", "H", "D", "C"]
RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]  # 11=J,12=Q,13=K,14=A


def new_deck() -> List[Tuple[int, str]]:
    return [(r, s) for s in SUITS for r in RANKS]


def hmac_commit(seed: bytes, deck: List[Tuple[int, str]]) -> str:
    msg = ",".join(f"{r}{s}" for r, s in deck).encode()
    return hmac.new(seed, msg, hashlib.sha256).hexdigest()


# --------- Data structures ---------
@dataclasses.dataclass
class Seat:
    seat_no: int
    user_id: Optional[int] = None
    username: Optional[str] = None
    stack: int = 0
    sitting_out: bool = False
    connected: bool = False


@dataclasses.dataclass
class PlayerInHand:
    user_id: int
    seat_no: int
    hole: List[Tuple[int, str]]
    has_folded: bool = False
    is_allin: bool = False
    street_bet: int = 0           # chips committed this street
    total_contrib: int = 0        # chips committed across all streets


@dataclasses.dataclass
class HandState:
    hand_id: int
    dealer_seat: int
    small_blind_seat: int
    big_blind_seat: int
    deck_seed: bytes
    deck_commit: str
    board: List[Tuple[int, str]]
    players: Dict[int, PlayerInHand]
    to_act_seat: Optional[int] = None
    min_raise: int = 0            # current min raise size for this street
    cur_bet: int = 0              # current highest street_bet
    pots: List[Dict[str, Any]] = dataclasses.field(default_factory=list)
    stage: str = "preflop"


class TableConfig(BaseModel):
    name: str = "Main Table"
    isPrivate: bool = False
    smallBlind: int = Field(50, gt=0)
    bigBlind: int = Field(100, gt=0)
    minBuyIn: int = Field(2000, gt=0)
    maxBuyIn: int = Field(200000, gt=0)
    maxSeats: int = Field(6, ge=2, le=9)


class TableSummary(BaseModel):
    id: str
    name: str
    isPrivate: bool
    smallBlind: int
    bigBlind: int
    minBuyIn: int
    maxBuyIn: int
    maxSeats: int
    seatsTaken: int
    status: str


class CreateTableIn(BaseModel):
    name: str = "Public Table"
    isPrivate: bool = False
    password: Optional[str] = None
    smallBlind: int = 50
    bigBlind: int = 100
    minBuyIn: int = 2000
    maxBuyIn: int = 200000
    maxSeats: int = 6


class JoinTableIn(BaseModel):
    tableId: str
    password: Optional[str] = None


class CashoutIn(BaseModel):
    tableId: str


class WsClient:
    def __init__(self, ws: WebSocket, user_id: int, username: str):
        self.ws = ws
        self.user_id = user_id
        self.username = username
        self.seat_no: Optional[int] = None


class PokerTable:
    ACTION_TIMEOUT_MS = 16000  # server-side timeout for a turn
    INTER_HAND_PAUSE_MS = 9000 # pause between hands for cash out / leave

    def __init__(self, table_id: str, cfg: TableConfig):
        self.id = table_id
        self.cfg = cfg
        self.seats: List[Seat] = [Seat(seat_no=i) for i in range(cfg.maxSeats)]
        self.clients: Set[WsClient] = set()
        self.lock = asyncio.Lock()
        self.hand: Optional[HandState] = None
        self.dealer_pos = 0
        self.next_hand_id = 1
        self._game_task: Optional[asyncio.Task] = None
        # Queue entries are (client, data) so we can validate actor
        self._actions_queue: asyncio.Queue = asyncio.Queue()
        # monotonic timestamp when next hand is allowed to start
        self._next_hand_ready_at: float = 0.0

    # --------- Connection / snapshots ---------

    async def connect(self, client: WsClient):
        await client.ws.accept()
        async with self.lock:
            self.clients.add(client)
        await self.send_snapshot(to=[client])

    async def disconnect(self, client: WsClient):
        async with self.lock:
            self.clients.discard(client)
            if client.seat_no is not None:
                s = self.seats[client.seat_no]
                s.connected = False
        await self.broadcast({"type": "PLAYER_LEFT", "seatNo": client.seat_no})

    async def broadcast(self, msg: Dict[str, Any], to: Optional[List[WsClient]] = None):
        targets = to if to is not None else list(self.clients)
        for c in list(targets):
            try:
                await c.ws.send_json(msg)
            except Exception:
                try:
                    await c.ws.close()
                except Exception:
                    pass
                self.clients.discard(c)

    def _hand_view_for_client(self, client: WsClient) -> Optional[Dict[str, Any]]:
        h = self.hand
        if not h:
            return None
        view = {
            "handId": h.hand_id,
            "dealerSeat": h.dealer_seat,
            "smallBlindSeat": h.small_blind_seat,
            "bigBlindSeat": h.big_blind_seat,
            "deckCommit": h.deck_commit,
            "board": [(r, s) for (r, s) in h.board],
            "pot": sum(p["amount"] for p in h.pots) if h.pots else sum(p.total_contrib for p in h.players.values()),
            "stage": h.stage,
            "toAct": h.to_act_seat,
            "minRaise": h.min_raise,
            "curBet": h.cur_bet,
            "players": [
                {
                    "seatNo": sn,
                    "hasFolded": p.has_folded,
                    "isAllIn": p.is_allin,
                    "streetBet": p.street_bet,
                    "totalContrib": p.total_contrib,
                }
                for sn, p in sorted(h.players.items())
            ],
        }
        if client.seat_no is not None and client.seat_no in h.players:
            hole = h.players[client.seat_no].hole
            view["myHole"] = [(r, s) for (r, s) in hole]
        return view

    async def send_snapshot(self, to: Optional[List[WsClient]] = None):
        targets = to if to is not None else list(self.clients)
        for c in list(targets):
            state = {
                "table": {
                    "id": self.id,
                    "name": self.cfg.name,
                    "smallBlind": self.cfg.smallBlind,
                    "bigBlind": self.cfg.bigBlind,
                    "minBuyIn": self.cfg.minBuyIn,
                    "maxBuyIn": self.cfg.maxBuyIn,
                    "maxSeats": self.cfg.maxSeats,
                },
                "seats": [dataclasses.asdict(s) for s in self.seats],
                "hand": self._hand_view_for_client(c),
            }
            try:
                await c.ws.send_json({"type": "TABLE_SNAPSHOT", "state": state})
            except Exception:
                try:
                    await c.ws.close()
                finally:
                    self.clients.discard(c)

    # --------- Seating / economy ---------

    async def take_seat(self, client: WsClient, seat_no: int):
        if not (0 <= seat_no < len(self.seats)):
            raise HTTPException(400, "Invalid seat")
        s = self.seats[seat_no]
        if s.user_id and s.user_id != client.user_id:
            raise HTTPException(400, "Seat taken")
        if client.seat_no is not None and client.seat_no != seat_no:
            raise HTTPException(400, "Already seated; cash out to change seats")
        s.user_id = client.user_id
        s.username = client.username
        s.connected = True
        client.seat_no = seat_no
        await self.broadcast({"type": "PLAYER_SEATED", "seatNo": seat_no, "user": {"id": client.user_id, "name": client.username}})
        await self.send_snapshot()
        self._ensure_game_loop()

    def _ensure_game_loop(self):
        if self._game_task is None or self._game_task.done():
            self._game_task = asyncio.create_task(self._run())

    async def buy_in(self, db: Session, client: WsClient, amount: int, user: User):
        if amount <= 0:
            raise HTTPException(400, "Buy-in must be positive")
        if amount < self.cfg.minBuyIn:
            raise HTTPException(400, f"Minimum buy-in is {self.cfg.minBuyIn}")
        if amount > self.cfg.maxBuyIn:
            raise HTTPException(400, f"Maximum buy-in is {self.cfg.maxBuyIn}")
        if user.balance_cents < amount:
            raise HTTPException(400, "Insufficient wallet balance")
        if client.seat_no is None:
            raise HTTPException(400, "Take a seat first")
        seat = self.seats[client.seat_no]
        db.add(Transaction(user_id=user.id, amount_cents=-amount, kind="buyin"))
        user.balance_cents -= amount
        db.commit()
        db.refresh(user)
        seat.stack += amount
        await self.broadcast({"type": "BUY_IN_APPLIED", "seatNo": seat.seat_no, "amount": amount, "stack": seat.stack})
        await self.send_snapshot()
        self._ensure_game_loop()

    async def cash_out(self, db: Session, client: WsClient, user: User) -> int:
        if client.seat_no is None:
            raise HTTPException(400, "Not seated")
        seat = self.seats[client.seat_no]
        if not seat.user_id or seat.user_id != user.id:
            raise HTTPException(403, "Seat not owned")
        if self.hand and client.seat_no in (self.hand.players.keys()):
            raise HTTPException(400, "Cannot cash out during a hand")
        amount = seat.stack
        if amount <= 0:
            await self._stand_up(client)
            await self.send_snapshot()
            return 0
        seat.stack = 0
        db.add(Transaction(user_id=user.id, amount_cents=amount, kind="cashout"))
        user.balance_cents += amount
        db.commit()
        db.refresh(user)
        await self.broadcast({"type": "CASHED_OUT", "seatNo": seat.seat_no, "amount": amount})
        await self._stand_up(client)
        await self.send_snapshot()
        return amount

    async def _stand_up(self, client: WsClient):
        if client.seat_no is None:
            return
        s = self.seats[client.seat_no]
        s.user_id = None
        s.username = None
        s.connected = False
        seat_no = client.seat_no
        client.seat_no = None
        await self.broadcast({"type": "PLAYER_LEFT", "seatNo": seat_no})

    async def _kick_zero_stack_players(self):
        in_hand = set(self.hand.players.keys()) if self.hand else set()
        for idx, s in enumerate(self.seats):
            if s.user_id is not None and s.stack <= 0 and idx not in in_hand:
                s.user_id = None
                s.username = None
                s.connected = False
                await self.broadcast({"type": "PLAYER_LEFT", "seatNo": idx})

    # --------- Game loop ---------

    async def _run(self):
        try:
            while True:
                await asyncio.sleep(0.08)
                # Respect inter-hand pause
                if self.hand is None and self._now() < self._next_hand_ready_at:
                    continue
                active = [s for s in self.seats if s.user_id and s.stack > 0 and not s.sitting_out and s.connected]
                if len(active) < 2 or self.hand is not None:
                    continue
                await self._play_hand()
        except asyncio.CancelledError:
            pass
        except Exception:
            pass

    # --------- Hand lifecycle ---------

    def _now(self) -> float:
        return time.monotonic()

    def _next_occupied(self, start_from: int) -> int:
        n = len(self.seats)
        i = (start_from + 1) % n
        for _ in range(n):
            s = self.seats[i]
            if s.user_id and s.stack > 0 and not s.sitting_out:
                return i
            i = (i + 1) % n
        return start_from

    def _shuffle_deck(self) -> Tuple[List[Tuple[int, str]], bytes, str]:
        deck = new_deck()
        seed = secrets.token_bytes(32)
        rng = secrets.SystemRandom(int.from_bytes(seed, "big"))
        rng.shuffle(deck)
        commit = hmac_commit(seed, deck)
        return deck, seed, commit

    async def _play_hand(self):
        # Clear any pause marker as we are starting a hand
        self._next_hand_ready_at = 0.0

        n = len(self.seats)

        # advance dealer to an occupied seat
        for _ in range(n):
            s = self.seats[self.dealer_pos]
            if s.user_id and s.stack > 0 and not s.sitting_out:
                break
            self.dealer_pos = (self.dealer_pos + 1) % n
        dealer = self.dealer_pos
        sb = self._next_occupied(dealer)
        bb = self._next_occupied(sb)
        if sb == bb:
            self.dealer_pos = (dealer + 1) % n
            return

        deck, seed, commit = self._shuffle_deck()

        # players in hand and deal hole cards
        players: Dict[int, PlayerInHand] = {}
        for off in range(1, n + 1):
            idx = (dealer + off) % n
            s = self.seats[idx]
            if s.user_id and s.stack > 0 and not s.sitting_out:
                players[idx] = PlayerInHand(user_id=s.user_id, seat_no=idx, hole=[deck.pop(), deck.pop()])

        self.hand = HandState(
            hand_id=self.next_hand_id,
            dealer_seat=dealer,
            small_blind_seat=sb,
            big_blind_seat=bb,
            deck_seed=seed,
            deck_commit=commit,
            board=[],
            players=players,
            to_act_seat=None,
            min_raise=self.cfg.bigBlind,
            cur_bet=self.cfg.bigBlind,  # preflop target is BB
            pots=[],
            stage="preflop",
        )
        self.next_hand_id += 1

        # post blinds
        def post_blind(seat_no: int, amt: int):
            if seat_no not in self.hand.players:
                return
            seat = self.seats[seat_no]
            pay = min(amt, seat.stack)
            seat.stack -= pay
            p = self.hand.players[seat_no]
            p.street_bet += pay
            p.total_contrib += pay
            if seat.stack == 0:
                p.is_allin = True

        post_blind(sb, self.cfg.smallBlind)
        post_blind(bb, self.cfg.bigBlind)

        await self.broadcast({"type": "HAND_STARTED", "handId": self.hand.hand_id, "dealerSeat": dealer, "smallBlindSeat": sb, "bigBlindSeat": bb, "deckCommit": commit})
        await self.send_snapshot()

        # Preflop betting starts UTG (left of BB)
        await self._betting_round(start_from=self._next_seat(bb), preflop=True)

        if not self.hand:
            return

        # Flop
        self._burn(deck); self._deal_to_board(deck, 3)
        self.hand.stage = "flop"
        self._reset_street()
        await self.broadcast({"type": "DEAL_FLOP", "cards": [(r, s) for (r, s) in self.hand.board]})
        await self.send_snapshot()
        await self._betting_round(start_from=self._next_seat(self.hand.dealer_seat))

        if not self.hand:
            return

        # Turn
        self._burn(deck); self._deal_to_board(deck, 1)
        self.hand.stage = "turn"
        self._reset_street()
        await self.broadcast({"type": "DEAL_TURN", "card": self.hand.board[-1]})
        await self.send_snapshot()
        await self._betting_round(start_from=self._next_seat(self.hand.dealer_seat))

        if not self.hand:
            return

        # River
        self._burn(deck); self._deal_to_board(deck, 1)
        self.hand.stage = "river"
        self._reset_street()
        await self.broadcast({"type": "DEAL_RIVER", "card": self.hand.board[-1]})
        await self.send_snapshot()
        await self._betting_round(start_from=self._next_seat(self.hand.dealer_seat))

        if not self.hand:
            return

        # Showdown and payout
        await self._resolve_showdown_and_payout()
        await self._end_hand(next_dealer=(dealer + 1) % n, seed=seed)

    # --------- Betting core ---------

    def _eligible_actor(self, sn: int) -> bool:
        if not self.hand:
            return False
        p = self.hand.players.get(sn)
        if not p:
            return False
        s = self.seats[sn]
        return (not p.has_folded) and (not p.is_allin) and s.user_id is not None and not s.sitting_out

    def _next_seat(self, cur: int) -> int:
        n = len(self.seats)
        i = (cur + 1) % n
        while True:
            if self.hand and i in self.hand.players and self._eligible_actor(i):
                return i
            i = (i + 1) % n

    def _active_set(self) -> Set[int]:
        return {sn for sn, p in self.hand.players.items() if not p.has_folded and not p.is_allin}

    def _everyone_matched(self) -> bool:
        h = self.hand
        for p in h.players.values():
            if not p.has_folded and not p.is_allin:
                if p.street_bet < h.cur_bet:
                    return False
        return True

    def _reset_street(self):
        for p in self.hand.players.values():
            p.street_bet = 0
        self.hand.cur_bet = 0
        self.hand.min_raise = self.cfg.bigBlind

    async def _flush_action_queue(self):
        try:
            while True:
                self._actions_queue.get_nowait()
        except Exception:
            pass

    async def _betting_round(self, start_from: int, preflop: bool = False):
        h = self.hand
        if not h:
            return

        if sum(1 for p in h.players.values() if not p.has_folded) <= 1:
            await self._single_winner_early()
            return

        await self._flush_action_queue()

        have_acted: Set[int] = set()
        active: Set[int] = self._active_set()
        last_raiser: Optional[int] = h.big_blind_seat if preflop else None

        current = start_from
        while True:
            if not self._eligible_actor(current):
                if len(self._active_set()) <= 1 or self._everyone_matched():
                    break
                current = self._next_seat(current)
                continue

            h.to_act_seat = current
            await self._emit_action_required(current)

            try:
                client, data = await asyncio.wait_for(self._actions_queue.get(), timeout=self.ACTION_TIMEOUT_MS / 1000.0)
            except asyncio.TimeoutError:
                p = h.players[current]
                to_call = max(0, h.cur_bet - p.street_bet)
                if to_call == 0:
                    await self.broadcast({"type": "PLAYER_ACTION_APPLIED", "seatNo": current, "action": "check", "amount": 0, "toCallNext": 0})
                    have_acted.add(current)
                else:
                    p.has_folded = True
                    await self.broadcast({"type": "PLAYER_ACTION_APPLIED", "seatNo": current, "action": "fold", "amount": 0, "toCallNext": 0})
                    active.discard(current)
                if len([sn for sn, pl in h.players.items() if not pl.has_folded]) <= 1:
                    await self._single_winner_early()
                    return
                if self._everyone_matched() and have_acted.issuperset(self._active_set()):
                    break
                current = self._next_seat(current)
                continue

            if client.seat_no != current:
                continue

            action = (data.get("action") or "").lower().strip()
            raw_amt = int(data.get("amount") or 0)

            p = h.players[current]
            seat = self.seats[current]
            to_call = max(0, h.cur_bet - p.street_bet)

            reopened = False

            if action in ("fold", "check/fold"):
                p.has_folded = True
                active.discard(current)
                await self.broadcast({"type": "PLAYER_ACTION_APPLIED", "seatNo": current, "action": "fold", "amount": 0, "toCallNext": 0})
            elif action == "check":
                if to_call != 0:
                    continue
                have_acted.add(current)
                await self.broadcast({"type": "PLAYER_ACTION_APPLIED", "seatNo": current, "action": "check", "amount": 0, "toCallNext": 0})
            elif action == "call":
                pay = min(to_call, seat.stack)
                seat.stack -= pay
                p.street_bet += pay
                p.total_contrib += pay
                if seat.stack == 0:
                    p.is_allin = True
                have_acted.add(current)
                await self.broadcast({"type": "PLAYER_ACTION_APPLIED", "seatNo": current, "action": "call", "amount": pay, "toCallNext": 0})
            elif action == "bet":
                if h.cur_bet != 0:
                    continue
                target_total = max(0, raw_amt)
                if target_total < h.min_raise:
                    if seat.stack + p.street_bet < h.min_raise:
                        target_total = seat.stack + p.street_bet
                    else:
                        continue
                inc = max(0, target_total - p.street_bet)
                inc = min(inc, seat.stack)
                if inc <= 0:
                    continue
                seat.stack -= inc
                p.street_bet += inc
                p.total_contrib += inc
                if seat.stack == 0:
                    p.is_allin = True
                prev_cur = h.cur_bet
                h.cur_bet = max(h.cur_bet, p.street_bet)
                h.min_raise = max(h.min_raise, h.cur_bet if prev_cur == 0 else h.cur_bet - prev_cur)
                last_raiser = current
                have_acted = {current}
                reopened = True
                await self.broadcast({"type": "PLAYER_ACTION_APPLIED", "seatNo": current, "action": "bet", "amount": inc, "toCallNext": 0})
            elif action == "raise":
                target_total = max(h.cur_bet, raw_amt)
                needed = max(0, target_total - p.street_bet)
                pay = min(needed, seat.stack)
                if pay <= 0 and target_total <= p.street_bet:
                    continue
                pre = h.cur_bet
                seat.stack -= pay
                p.street_bet += pay
                p.total_contrib += pay
                if seat.stack == 0:
                    p.is_allin = True
                if p.street_bet > h.cur_bet:
                    raise_size = p.street_bet - pre
                    if raise_size >= h.min_raise:
                        h.min_raise = raise_size
                        h.cur_bet = p.street_bet
                        last_raiser = current
                        have_acted = {current}
                        reopened = True
                    else:
                        h.cur_bet = p.street_bet
                        have_acted.add(current)
                else:
                    have_acted.add(current)
                await self.broadcast({"type": "PLAYER_ACTION_APPLIED", "seatNo": current, "action": "raise", "amount": pay, "toCallNext": 0})
            else:
                continue

            if len([sn for sn, pl in h.players.items() if not pl.has_folded]) <= 1:
                await self._single_winner_early()
                return

            if self._everyone_matched() and have_acted.issuperset(self._active_set()):
                break

            current = self._next_seat(current)

        h.to_act_seat = None
        await self.send_snapshot()

    async def _emit_action_required(self, seat_no: int):
        if not self.hand:
            return
        p = self.hand.players.get(seat_no)
        if not p or p.has_folded or p.is_allin:
            return
        to_call = max(0, self.hand.cur_bet - p.street_bet)
        await self.broadcast({
            "type": "ACTION_REQUIRED",
            "seatNo": seat_no,
            "minRaise": self.hand.min_raise,
            "toCall": to_call,
            "timeLeftMs": self.ACTION_TIMEOUT_MS,
        })
        await self.send_snapshot()

    async def _single_winner_early(self):
        if not self.hand:
            return
        alive = [sn for sn, p in self.hand.players.items() if not p.has_folded]
        if not alive:
            return
        winner = alive[0]
        pot = sum(p.total_contrib for p in self.hand.players.values())
        self.seats[winner].stack += pot
        await self.broadcast({"type": "POT_AWARDED", "potIndex": 0, "seatNo": winner, "amount": pot})
        await self._end_hand(next_dealer=(self.hand.dealer_seat + 1) % len(self.seats), seed=self.hand.deck_seed)

    # --------- Dealing helpers ---------

    def _burn(self, deck: List[Tuple[int, str]]):
        if deck:
            deck.pop()

    def _deal_to_board(self, deck: List[Tuple[int, str]], n: int):
        for _ in range(n):
            if deck:
                self.hand.board.append(deck.pop())

    # --------- Pots & showdown ---------

    def _build_side_pots(self) -> List[Dict[str, Any]]:
        contribs = {sn: p.total_contrib for sn, p in self.hand.players.items()}
        alive = {sn for sn, p in self.hand.players.items() if not p.has_folded}
        if not any(contribs.values()):
            return []
        caps = sorted(set(v for v in contribs.values() if v > 0))
        pots: List[Dict[str, Any]] = []
        prev_cap = 0
        for cap in caps:
            tier = [sn for sn, v in contribs.items() if v >= cap]
            slice_total = sum(max(0, min(contribs[sn], cap) - prev_cap) for sn in tier)
            if slice_total > 0:
                pots.append({"amount": slice_total, "eligible": [sn for sn in tier if sn in alive]})
            prev_cap = cap
        merged: List[Dict[str, Any]] = []
        for p in pots:
            if not merged or merged[-1]["eligible"] != p["eligible"]:
                merged.append({"amount": p["amount"], "eligible": list(p["eligible"])})
            else:
                merged[-1]["amount"] += p["amount"]
        return merged

    async def _resolve_showdown_and_payout(self):
        h = self.hand
        ranks: Dict[int, Tuple[int, ...]] = {}
        for sn, p in h.players.items():
            if p.has_folded:
                continue
            combo = p.hole + h.board
            ranks[sn] = simple_rank_7(combo)

        pots = self._build_side_pots()
        h.pots = pots
        await self.broadcast({"type": "SHOWDOWN", "hands": None, "pots": pots})

        for idx, pot in enumerate(pots):
            if pot["amount"] <= 0 or not pot["eligible"]:
                continue
            best_rank: Optional[Tuple[int, ...]] = None
            for sn in pot["eligible"]:
                r = ranks.get(sn)
                if r is None:
                    continue
                if best_rank is None or r > best_rank:
                    best_rank = r
            winners = [sn for sn in pot["eligible"] if ranks.get(sn) == best_rank]
            share = pot["amount"] // len(winners)
            rem = pot["amount"] % len(winners)
            for i, w in enumerate(winners):
                self.seats[w].stack += share + (1 if i < rem else 0)
                await self.broadcast({"type": "POT_AWARDED", "potIndex": idx, "seatNo": w, "amount": share + (1 if i < rem else 0)})

    async def _end_hand(self, next_dealer: int, seed: bytes):
        # Set inter-hand pause and publish remaining wait
        self._next_hand_ready_at = self._now() + (self.INTER_HAND_PAUSE_MS / 1000.0)
        wait_ms = max(0, int((self._next_hand_ready_at - self._now()) * 1000))

        await self.broadcast({"type": "HAND_ENDED", "nextDealerSeat": next_dealer, "seed": seed.hex(), "waitMs": wait_ms})
        self.dealer_pos = next_dealer
        self.hand = None
        await self._kick_zero_stack_players()
        await self.send_snapshot()

    # --------- WS message handling ---------

    async def on_message(self, client: WsClient, data: Dict[str, Any], db: Session, user: User):
        t = data.get("type")
        try:
            if t == "SEAT_TAKE":
                await self.take_seat(client, int(data.get("seatNo")))
            elif t == "BUY_IN":
                await self.buy_in(db, client, int(data.get("amount") or 0), user)
            elif t == "LEAVE_TABLE":
                if client.seat_no is not None:
                    s = self.seats[client.seat_no]
                    s.sitting_out = True
                    await self.broadcast({"type": "PLAYER_LEFT", "seatNo": client.seat_no})
            elif t == "CASH_OUT":
                amount = await self.cash_out(db, client, user)
                await client.ws.send_json({"type": "CASH_OUT_OK", "amount": amount, "newBalance": user.balance_cents})
            elif t == "SIT_OUT":
                if client.seat_no is not None:
                    self.seats[client.seat_no].sitting_out = True
                    await self.broadcast({"type": "PLAYER_SIT_OUT", "seatNo": client.seat_no})
            elif t == "SIT_IN":
                if client.seat_no is not None:
                    self.seats[client.seat_no].sitting_out = False
                    await self.broadcast({"type": "PLAYER_SIT_IN", "seatNo": client.seat_no})
                    self._ensure_game_loop()
            elif t == "PLAYER_ACTION":
                self._actions_queue.put_nowait((client, data))
            else:
                await client.ws.send_json({"type": "ERROR", "reason": f"Unknown message {t}"})
        except Exception as e:
            reason = getattr(e, "detail", None) or str(e)
            try:
                await client.ws.send_json({"type": "ERROR", "reason": reason})
            except Exception:
                pass


class PokerManager:
    def __init__(self):
        self.tables: Dict[str, PokerTable] = {}
        self.get_or_create("main", TableConfig())

    def list_tables(self) -> List[TableSummary]:
        out: List[TableSummary] = []
        for tid in sorted(self.tables.keys(), key=lambda k: (k != "main", k)):
            t = self.tables[tid]
            out.append(
                TableSummary(
                    id=tid,
                    name=t.cfg.name,
                    isPrivate=t.cfg.isPrivate,
                    smallBlind=t.cfg.smallBlind,
                    bigBlind=t.cfg.bigBlind,
                    minBuyIn=t.cfg.minBuyIn,
                    maxBuyIn=t.cfg.maxBuyIn,
                    maxSeats=t.cfg.maxSeats,
                    seatsTaken=sum(1 for s in t.seats if s.user_id is not None),
                    status="running" if t.hand else "waiting",
                )
            )
        return out

    def get_or_create(self, table_id: str, cfg: Optional[TableConfig] = None) -> PokerTable:
        if table_id in self.tables:
            return self.tables[table_id]
        if cfg is None:
            cfg = TableConfig()
        t = PokerTable(table_id, cfg)
        self.tables[table_id] = t
        return t


MANAGER = PokerManager()


@router.get("/tables", response_model=List[TableSummary])
def list_tables(user: User = Depends(current_user)):
    return MANAGER.list_tables()


@router.post("/tables", response_model=TableSummary)
def create_table(body: CreateTableIn, user: User = Depends(current_user)):
    tid = secrets.token_hex(4)
    cfg = TableConfig(
        name=body.name,
        isPrivate=body.isPrivate,
        smallBlind=body.smallBlind,
        bigBlind=body.bigBlind,
        minBuyIn=body.minBuyIn,
        maxBuyIn=body.maxBuyIn,
        maxSeats=body.maxSeats,
    )
    MANAGER.get_or_create(tid, cfg)
    return TableSummary(
        id=tid,
        name=cfg.name,
        isPrivate=cfg.isPrivate,
        smallBlind=cfg.smallBlind,
        bigBlind=cfg.bigBlind,
        minBuyIn=cfg.minBuyIn,
        maxBuyIn=cfg.maxBuyIn,
        maxSeats=cfg.maxSeats,
        seatsTaken=0,
        status="waiting",
    )


@router.post("/join")
def join_table(body: JoinTableIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    t = MANAGER.get_or_create(body.tableId)
    open_seat = next((s for s in t.seats if s.user_id in (None, user.id)), None)
    if not open_seat:
        raise HTTPException(400, "Table full")
    return {"ok": True, "tableId": t.id, "minBuyIn": t.cfg.minBuyIn, "maxBuyIn": t.cfg.maxBuyIn}


@router.post("/cashout")
def cashout(body: CashoutIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    t = MANAGER.get_or_create(body.tableId)
    seat_idx = next((i for i, s in enumerate(t.seats) if s.user_id == user.id), None)
    if seat_idx is None:
        raise HTTPException(400, "Not seated")
    seat = t.seats[seat_idx]
    if t.hand and seat_idx in t.hand.players:
        raise HTTPException(400, "Cannot cash out during a hand")
    amount = seat.stack
    if amount <= 0:
        return {"amount": 0, "newBalance": user.balance_cents}
    seat.stack = 0
    db.add(Transaction(user_id=user.id, amount_cents=amount, kind="cashout"))
    user.balance_cents += amount
    db.commit()
    return {"amount": amount, "newBalance": user.balance_cents}


@router.websocket("/ws/{table_id}")
async def ws_table(ws: WebSocket, table_id: str, db: Session = Depends(get_db)):
    # Cookie auth
    from jose import jwt, JWTError
    from ..security import JWT_SECRET, JWT_ALG, COOKIE_NAME
    token = ws.cookies.get(COOKIE_NAME)
    if not token:
        await ws.close(code=4401)
        return
    try:
        data = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
        uid = int(data["sub"])
    except JWTError:
        await ws.close(code=4401)
        return
    user = db.query(User).get(uid)
    if not user:
        await ws.close(code=4401)
        return

    t = MANAGER.get_or_create(table_id)
    client = WsClient(ws, user_id=user.id, username=user.username)
    await t.connect(client)
    try:
        while True:
            payload = await ws.receive_json()
            if not isinstance(payload, dict):
                continue
            await t.on_message(client, payload, db, user)
    except WebSocketDisconnect:
        await t.disconnect(client)


# --------- Very simple 7-card evaluator (demo-level) ---------
def simple_rank_7(cards: List[Tuple[int, str]]) -> Tuple[int, ...]:
    # Category ranking: 8 SF, 7 quads, 6 FH, 5 flush, 4 straight, 3 trips, 2 two pair, 1 pair, 0 high
    from collections import Counter
    ranks = [r for r, _ in cards]
    suits = [s for _, s in cards]
    rc = Counter(ranks)
    sc = Counter(suits)
    uniq = sorted(set(ranks), reverse=True)

    def straight_high(rs: Set[int]) -> int:
        arr = sorted(rs, reverse=True)
        if 14 in rs:
            arr.append(1)
        run = 1
        best = 0
        for i in range(len(arr) - 1):
            if arr[i] - 1 == arr[i + 1]:
                run += 1
                if run >= 5:
                    best = max(best, arr[i - 3])
            elif arr[i] != arr[i + 1]:
                run = 1
        return best

    # straight flush
    for s, cnt in sc.items():
        if cnt >= 5:
            rh = straight_high({r for r, ss in cards if ss == s})
            if rh:
                return (8, rh)
    # quads
    quads = [r for r, c in rc.items() if c == 4]
    if quads:
        q = max(quads)
        kick = max(x for x in uniq if x != q)
        return (7, q, kick)
    # full house
    trips = sorted([r for r, c in rc.items() if c == 3], reverse=True)
    pairs = sorted([r for r, c in rc.items() if c == 2], reverse=True)
    if trips and (len(trips) >= 2 or pairs):
        t = trips[0]
        p = trips[1] if len(trips) >= 2 else pairs[0]
        return (6, t, p)
    # flush
    for s, cnt in sc.items():
        if cnt >= 5:
            top5 = sorted([r for r, ss in cards if ss == s], reverse=True)[:5]
            return (5, *top5)
    # straight
    sh = straight_high(set(uniq))
    if sh:
        return (4, sh)
    # trips
    if trips:
        t = trips[0]
        kicks = [r for r in uniq if r != t][:2]
        return (3, t, *kicks)
    # two pair
    if len(pairs) >= 2:
        a, b = pairs[:2]
        k = max(x for x in uniq if x not in (a, b))
        return (2, a, b, k)
    # one pair
    if len(pairs) == 1:
        p = pairs[0]
        kicks = [r for r in uniq if r != p][:3]
        return (1, p, *kicks)
    # high card
    top5 = uniq[:5]
    return (0, *top5)
