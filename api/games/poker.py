"""
Texas Hold'em Poker Implementation
Server-authoritative architecture following CLAUDE.md specifications
"""
import asyncio
import dataclasses
import hashlib
import hmac
import secrets
import time
from typing import Any, Dict, List, Optional, Set, Tuple, Union
from enum import Enum

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..models import Transaction, User
from ..security import current_user, get_db

router = APIRouter(prefix="/poker", tags=["poker"])

# --------- Constants ---------
SUITS = ["S", "H", "D", "C"]
RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]  # 11=J,12=Q,13=K,14=A

class Stage(str, Enum):
    PREFLOP = "preflop"
    FLOP = "flop"
    TURN = "turn"
    RIVER = "river"
    SHOWDOWN = "showdown"

class ActionType(str, Enum):
    FOLD = "fold"
    CHECK = "check"
    CALL = "call"
    BET = "bet"
    RAISE = "raise"

class EventType(str, Enum):
    HAND_STARTED = "HAND_STARTED"
    BLINDS_POSTED = "BLINDS_POSTED"
    CARDS_DEALT = "CARDS_DEALT"
    STREET_REVEALED = "STREET_REVEALED"
    ACTION_REQUIRED = "ACTION_REQUIRED"
    PLAYER_ACTED = "PLAYER_ACTED"
    BETTING_COMPLETE = "BETTING_COMPLETE"
    POT_AWARDED = "POT_AWARDED"
    HAND_COMPLETE = "HAND_COMPLETE"
    GAME_STATE = "GAME_STATE"

# --------- Data Models ---------
@dataclasses.dataclass
class Seat:
    seat_no: int
    user_id: Optional[int] = None
    username: Optional[str] = None
    stack: int = 0  # cents
    is_sitting_out: bool = False
    is_connected: bool = True

@dataclasses.dataclass
class PlayerInHand:
    user_id: int
    seat_no: int
    hole_cards: List[Tuple[int, str]]  # [(rank, suit), ...]
    
    # Betting state
    has_folded: bool = False
    is_all_in: bool = False
    street_contribution: int = 0  # Amount bet this street
    total_contribution: int = 0   # Amount bet this hand
    
    # Results
    hand_ranking: Optional[Tuple] = None
    winning_cards: List[int] = dataclasses.field(default_factory=list)

@dataclasses.dataclass
class SidePot:
    amount: int
    eligible_seats: List[int]
    winners: List[int] = dataclasses.field(default_factory=list)

@dataclasses.dataclass
class HandResult:
    player_seat: int
    ranking: Tuple[int, ...]  # For comparison (higher is better)
    hand_type: str           # "Full House", "Flush", etc.
    description: str         # "Kings full of Aces"
    winning_hole_indices: List[int]   # Which hole cards used
    winning_board_indices: List[int]  # Which community cards used

@dataclasses.dataclass
class Winner:
    seat_no: int
    amount_won: int
    hand_result: HandResult
    pot_index: int = 0  # 0 = main pot, 1+ = side pots

@dataclasses.dataclass
class PlayerAction:
    seat_no: int
    action: ActionType
    amount: int = 0

@dataclasses.dataclass
class Event:
    event_type: EventType
    data: Dict[str, Any]
    timestamp: float = dataclasses.field(default_factory=time.time)

@dataclasses.dataclass 
class HandState:
    hand_id: int
    
    # Hand setup
    dealer_seat: int
    small_blind_seat: int
    big_blind_seat: int
    deck_commit: str  # For provable fairness
    deck_seed: bytes = dataclasses.field(repr=False)  # For recreating deck
    deck: List[Tuple[int, str]] = dataclasses.field(default_factory=list, repr=False)
    cards_dealt: int = 0  # Track how many cards have been dealt from deck
    
    # Game progression
    stage: Stage = Stage.PREFLOP
    board: List[Tuple[int, str]] = dataclasses.field(default_factory=list)
    
    # Players and actions
    players: Dict[int, PlayerInHand] = dataclasses.field(default_factory=dict)
    
    # Betting state
    current_bet: int = 0
    minimum_raise: int = 0
    to_act: Optional[int] = None
    betting_complete: bool = False
    
    # Pot and results
    pots: List[SidePot] = dataclasses.field(default_factory=list)
    winners: List[Winner] = dataclasses.field(default_factory=list)

@dataclasses.dataclass
class GameState:
    # Table configuration
    table_id: str
    seats: List[Seat]  # Fixed seat positions
    
    # Hand state (None when no active hand)
    hand: Optional[HandState] = None
    
    # Game flow control
    dealer_position: int = 0
    next_hand_id: int = 1

# --------- Pydantic Models for API ---------
class TableConfig(BaseModel):
    table_id: str
    name: str
    max_seats: int = 6
    small_blind: int = 50   # cents
    big_blind: int = 100    # cents 
    min_buy_in: int = 2000  # cents
    max_buy_in: int = 20000 # cents
    auto_start: bool = False

class TableSummary(BaseModel):
    id: str
    name: str
    isPrivate: bool = False
    smallBlind: int
    bigBlind: int
    minBuyIn: int
    maxBuyIn: int
    maxSeats: int
    seatsTaken: int
    status: str

# --------- Deck and Card Utilities ---------
def new_deck() -> List[Tuple[int, str]]:
    """Create a new shuffled deck"""
    deck = [(r, s) for s in SUITS for r in RANKS]
    # Shuffle using cryptographically secure random
    import random
    rng = random.SystemRandom()
    rng.shuffle(deck)
    return deck

def hmac_commit(seed: bytes, deck: List[Tuple[int, str]]) -> str:
    """Create HMAC commitment for provable fairness"""
    msg = ",".join(f"{r}{s}" for r, s in deck).encode()
    return hmac.new(seed, msg, hashlib.sha256).hexdigest()

def deck_from_seed(seed: bytes) -> List[Tuple[int, str]]:
    """Recreate deck from seed for verification"""
    deck = [(r, s) for s in SUITS for r in RANKS]
    import random
    rng = random.Random(seed)
    rng.shuffle(deck)
    return deck

# --------- Hand Evaluation ---------
def evaluate_hand(hole_cards: List[Tuple[int, str]], 
                 board_cards: List[Tuple[int, str]]) -> HandResult:
    """
    Evaluate 7-card hand and return best 5-card result
    Returns HandResult with ranking, description, and winning card indices
    """
    from itertools import combinations
    
    if not hole_cards or len(hole_cards) != 2 or not board_cards:
        return HandResult(
            player_seat=0,
            ranking=(0,),
            hand_type="Unknown",
            description="Invalid hand",
            winning_hole_indices=[],
            winning_board_indices=[]
        )
    
    all_cards = hole_cards + board_cards
    if len(all_cards) < 5:
        return HandResult(
            player_seat=0,
            ranking=(0,),
            hand_type="Unknown", 
            description="Insufficient cards",
            winning_hole_indices=[],
            winning_board_indices=[]
        )
    
    best_hand = None
    best_indices = []
    
    # Try all 5-card combinations
    for combo_indices in combinations(range(len(all_cards)), 5):
        combo = [all_cards[i] for i in combo_indices]
        ranking = _evaluate_5_cards(combo)
        
        if best_hand is None or ranking > best_hand:
            best_hand = ranking
            best_indices = list(combo_indices)
    
    # Separate hole and board indices
    winning_hole_indices = [i for i in best_indices if i < 2]
    winning_board_indices = [i - 2 for i in best_indices if i >= 2]
    
    # Get hand type description
    hand_type_names = {
        8: "Straight Flush",
        7: "Four of a Kind", 
        6: "Full House",
        5: "Flush",
        4: "Straight",
        3: "Three of a Kind",
        2: "Two Pair",
        1: "One Pair",
        0: "High Card"
    }
    
    hand_type = hand_type_names.get(best_hand[0], "Unknown")
    winning_cards = [all_cards[i] for i in best_indices]
    description = _get_hand_description(best_hand, winning_cards)
    
    return HandResult(
        player_seat=0,
        ranking=best_hand,
        hand_type=hand_type,
        description=description,
        winning_hole_indices=winning_hole_indices,
        winning_board_indices=winning_board_indices
    )

def _evaluate_5_cards(cards: List[Tuple[int, str]]) -> Tuple[int, ...]:
    """Evaluate exactly 5 cards and return ranking tuple"""
    from collections import Counter
    
    ranks = [r for r, _ in cards]
    suits = [s for _, s in cards]
    rc = Counter(ranks)
    
    # Check for flush
    is_flush = len(set(suits)) == 1
    
    # Check for straight
    sorted_ranks = sorted(set(ranks), reverse=True)
    is_straight = False
    straight_high = 0
    
    # Standard straight check
    if len(sorted_ranks) == 5:
        if sorted_ranks[0] - sorted_ranks[4] == 4:
            is_straight = True
            straight_high = sorted_ranks[0]
    
    # Check for A-2-3-4-5 wheel straight
    if set(ranks) == {14, 2, 3, 4, 5}:
        is_straight = True
        straight_high = 5  # 5-high straight
    
    # Get rank counts
    counts = sorted(rc.values(), reverse=True)
    rank_values = sorted(rc.keys(), key=lambda x: (rc[x], x), reverse=True)
    
    # Straight flush
    if is_straight and is_flush:
        return (8, straight_high)
    
    # Four of a kind
    if counts == [4, 1]:
        quad = rank_values[0]
        kicker = rank_values[1]
        return (7, quad, kicker)
    
    # Full house
    if counts == [3, 2]:
        trips = rank_values[0]
        pair = rank_values[1]
        return (6, trips, pair)
    
    # Flush
    if is_flush:
        return (5, *sorted(ranks, reverse=True))
    
    # Straight
    if is_straight:
        return (4, straight_high)
    
    # Three of a kind
    if counts == [3, 1, 1]:
        trips = rank_values[0]
        kickers = sorted([r for r in rank_values[1:]], reverse=True)
        return (3, trips, *kickers)
    
    # Two pair
    if counts == [2, 2, 1]:
        pairs = sorted([r for r in rank_values[:2]], reverse=True)
        kicker = rank_values[2]
        return (2, *pairs, kicker)
    
    # One pair
    if counts == [2, 1, 1, 1]:
        pair = rank_values[0]
        kickers = sorted([r for r in rank_values[1:]], reverse=True)
        return (1, pair, *kickers)
    
    # High card
    return (0, *sorted(ranks, reverse=True))

def _get_hand_description(ranking: Tuple[int, ...], winning_cards: List[Tuple[int, str]]) -> str:
    """Generate human-readable description of the hand"""
    hand_type = ranking[0]
    
    rank_names = {14: "Ace", 13: "King", 12: "Queen", 11: "Jack"}
    def rank_name(r): return rank_names.get(r, str(r))
    def plural_rank_name(r): return rank_names.get(r, str(r)) + ("s" if r not in rank_names else "s")
    
    if hand_type == 8:  # Straight flush
        high = ranking[1]
        if high == 14:
            return "Royal Flush"
        elif high == 5:
            return "Straight Flush, 5-high"
        else:
            return f"Straight Flush, {rank_name(high)}-high"
    elif hand_type == 7:  # Four of a kind
        quad = ranking[1]
        return f"Four {plural_rank_name(quad)}"
    elif hand_type == 6:  # Full house
        trips = ranking[1]
        pair = ranking[2]
        return f"{plural_rank_name(trips)} full of {plural_rank_name(pair)}"
    elif hand_type == 5:  # Flush
        high = ranking[1]
        return f"Flush, {rank_name(high)}-high"
    elif hand_type == 4:  # Straight
        high = ranking[1]
        if high == 5:
            return "Straight, 5-high"
        else:
            return f"Straight, {rank_name(high)}-high"
    elif hand_type == 3:  # Three of a kind
        trips = ranking[1]
        return f"Three {plural_rank_name(trips)}"
    elif hand_type == 2:  # Two pair
        high_pair = ranking[1]
        low_pair = ranking[2]
        return f"Two Pair, {plural_rank_name(high_pair)} and {plural_rank_name(low_pair)}"
    elif hand_type == 1:  # One pair
        pair = ranking[1]
        return f"Pair of {plural_rank_name(pair)}"
    else:  # High card
        high = ranking[1]
        return f"{rank_name(high)}-high"

# --------- State Machine ---------
class PokerStateMachine:
    """Handles all game state transitions"""
    
    def __init__(self, config: TableConfig):
        self.config = config
        self.game_state = GameState(
            table_id=config.table_id,
            seats=[Seat(seat_no=i) for i in range(config.max_seats)]
        )
    
    def start_hand(self) -> List[Event]:
        """Initialize new hand with dealer rotation and blind posting"""
        events = []
        
        # Find active players
        active_seats = [s for s in self.game_state.seats 
                       if s.user_id and s.stack > 0 and not s.is_sitting_out]
        
        if len(active_seats) < 2:
            return []  # Need at least 2 players
        
        # Advance dealer to next active seat
        dealer_found = False
        for _ in range(len(self.game_state.seats)):
            seat = self.game_state.seats[self.game_state.dealer_position]
            if seat.user_id and seat.stack > 0 and not seat.is_sitting_out:
                dealer_found = True
                break
            self.game_state.dealer_position = (self.game_state.dealer_position + 1) % len(self.game_state.seats)
        
        if not dealer_found:
            return []
        
        dealer_seat = self.game_state.dealer_position
        small_blind_seat = self._next_active_seat(dealer_seat)
        big_blind_seat = self._next_active_seat(small_blind_seat)
        
        if small_blind_seat is None or big_blind_seat is None:
            return []
        
        # Create shuffled deck
        deck_seed = secrets.randbits(256).to_bytes(32, 'big')
        deck = deck_from_seed(deck_seed)
        deck_commit = hmac_commit(deck_seed, deck)
        
        # Deal hole cards
        players = {}
        card_index = 0
        for seat in active_seats:
            hole_cards = [deck[card_index], deck[card_index + 1]]
            players[seat.seat_no] = PlayerInHand(
                user_id=seat.user_id,
                seat_no=seat.seat_no,
                hole_cards=hole_cards
            )
            card_index += 2
        
        # Create hand state
        self.game_state.hand = HandState(
            hand_id=self.game_state.next_hand_id,
            dealer_seat=dealer_seat,
            small_blind_seat=small_blind_seat,
            big_blind_seat=big_blind_seat,
            deck_commit=deck_commit,
            deck_seed=deck_seed,
            deck=deck,
            cards_dealt=card_index,  # Track cards already dealt for hole cards
            players=players,
            current_bet=self.config.big_blind,
            minimum_raise=self.config.big_blind
        )
        
        self.game_state.next_hand_id += 1
        
        # Post blinds
        self._post_blind(small_blind_seat, self.config.small_blind)
        self._post_blind(big_blind_seat, self.config.big_blind)
        
        # Set first to act (left of big blind)
        first_to_act = self._next_active_seat(big_blind_seat)
        self.game_state.hand.to_act = first_to_act
        
        events.append(Event(
            event_type=EventType.HAND_STARTED,
            data={
                "hand_id": self.game_state.hand.hand_id,
                "dealer_seat": dealer_seat,
                "small_blind_seat": small_blind_seat,
                "big_blind_seat": big_blind_seat,
                "deck_commit": deck_commit
            }
        ))
        
        events.append(Event(
            event_type=EventType.BLINDS_POSTED,
            data={
                "small_blind": {"seat": small_blind_seat, "amount": self.config.small_blind},
                "big_blind": {"seat": big_blind_seat, "amount": self.config.big_blind}
            }
        ))
        
        if first_to_act is not None:
            events.append(Event(
                event_type=EventType.ACTION_REQUIRED,
                data={
                    "seat_no": first_to_act,
                    "min_raise": self.game_state.hand.minimum_raise,
                    "to_call": self._get_to_call(first_to_act)
                }
            ))
        
        return events
    
    def process_action(self, seat_no: int, action: PlayerAction) -> List[Event]:
        """Validate and process player action"""
        events = []
        
        if not self.game_state.hand:
            return []
        
        # Validate it's player's turn
        if self.game_state.hand.to_act != seat_no:
            return []
        
        player = self.game_state.hand.players.get(seat_no)
        if not player or player.has_folded or player.is_all_in:
            return []
        
        seat = self.game_state.seats[seat_no]
        to_call = self._get_to_call(seat_no)
        
        # Process action
        if action.action == ActionType.FOLD:
            player.has_folded = True
        elif action.action == ActionType.CHECK:
            if to_call > 0:
                return []  # Can't check with bet to call
        elif action.action == ActionType.CALL:
            amount = min(to_call, seat.stack)
            self._make_bet(seat_no, amount)
        elif action.action == ActionType.BET:
            if self.game_state.hand.current_bet > 0:
                return []  # Can't bet when there's already a bet
            amount = min(action.amount, seat.stack)
            if amount < self.game_state.hand.minimum_raise and seat.stack > self.game_state.hand.minimum_raise:
                return []  # Invalid bet size
            self._make_bet(seat_no, amount)
            self.game_state.hand.current_bet = player.street_contribution
            self.game_state.hand.minimum_raise = amount
        elif action.action == ActionType.RAISE:
            total_bet = min(action.amount, seat.stack + player.street_contribution)
            raise_amount = total_bet - self.game_state.hand.current_bet
            if raise_amount < self.game_state.hand.minimum_raise and seat.stack > raise_amount:
                return []  # Invalid raise size
            bet_amount = total_bet - player.street_contribution
            self._make_bet(seat_no, bet_amount)
            self.game_state.hand.current_bet = total_bet
            self.game_state.hand.minimum_raise = raise_amount
        
        events.append(Event(
            event_type=EventType.PLAYER_ACTED,
            data={
                "seat_no": seat_no,
                "action": action.action.value,
                "amount": getattr(action, 'amount', 0)
            }
        ))
        
        # Move to next player or complete betting round
        next_events = self._advance_action()
        events.extend(next_events)
        
        return events
    
    def _advance_action(self) -> List[Event]:
        """Move to next player or complete betting round"""
        events = []
        
        if not self.game_state.hand:
            return events
        
        # Find next active player
        next_seat = self._next_active_player(self.game_state.hand.to_act)
        
        # Check if betting round is complete
        if self._is_betting_complete():
            self.game_state.hand.betting_complete = True
            events.append(Event(
                event_type=EventType.BETTING_COMPLETE,
                data={}
            ))
            
            # Advance to next street or showdown
            advance_events = self.advance_street()
            events.extend(advance_events)
        else:
            self.game_state.hand.to_act = next_seat
            if next_seat is not None:
                events.append(Event(
                    event_type=EventType.ACTION_REQUIRED,
                    data={
                        "seat_no": next_seat,
                        "min_raise": self.game_state.hand.minimum_raise,
                        "to_call": self._get_to_call(next_seat)
                    }
                ))
        
        return events
    
    def advance_street(self) -> List[Event]:
        """Progress from preflop -> flop -> turn -> river -> showdown"""
        events = []
        
        if not self.game_state.hand:
            return events
        
        # Reset betting for new street
        for player in self.game_state.hand.players.values():
            player.street_contribution = 0
        self.game_state.hand.current_bet = 0
        self.game_state.hand.minimum_raise = self.config.big_blind
        self.game_state.hand.betting_complete = False
        
        if self.game_state.hand.stage == Stage.PREFLOP:
            self.game_state.hand.stage = Stage.FLOP
            # Burn one card then deal 3 for flop
            self._burn_card()
            flop_cards = [
                self._deal_card(),
                self._deal_card(),
                self._deal_card()
            ]
            self.game_state.hand.board.extend(flop_cards)
            
            events.append(Event(
                event_type=EventType.STREET_REVEALED,
                data={"stage": "flop", "cards": flop_cards}
            ))
            
        elif self.game_state.hand.stage == Stage.FLOP:
            self.game_state.hand.stage = Stage.TURN
            # Burn one card then deal turn
            self._burn_card()
            turn_card = self._deal_card()
            self.game_state.hand.board.append(turn_card)
            
            events.append(Event(
                event_type=EventType.STREET_REVEALED,
                data={"stage": "turn", "card": turn_card}
            ))
            
        elif self.game_state.hand.stage == Stage.TURN:
            self.game_state.hand.stage = Stage.RIVER
            # Burn one card then deal river
            self._burn_card()
            river_card = self._deal_card()
            self.game_state.hand.board.append(river_card)
            
            events.append(Event(
                event_type=EventType.STREET_REVEALED,
                data={"stage": "river", "card": river_card}
            ))
            
        elif self.game_state.hand.stage == Stage.RIVER:
            # Go to showdown
            showdown_events = self.determine_winners()
            events.extend(showdown_events)
            return events
        
        # Set next to act (first active player after dealer)
        first_to_act = self._next_active_player(self.game_state.hand.dealer_seat)
        self.game_state.hand.to_act = first_to_act
        
        if first_to_act is not None:
            events.append(Event(
                event_type=EventType.ACTION_REQUIRED,
                data={
                    "seat_no": first_to_act,
                    "min_raise": self.game_state.hand.minimum_raise,
                    "to_call": self._get_to_call(first_to_act)
                }
            ))
        
        return events
    
    def determine_winners(self) -> List[Event]:
        """Calculate hand rankings and distribute pots"""
        events = []
        
        if not self.game_state.hand:
            return events
        
        self.game_state.hand.stage = Stage.SHOWDOWN
        
        # Calculate hand results for all non-folded players
        hand_results = {}
        for seat_no, player in self.game_state.hand.players.items():
            if not player.has_folded:
                result = evaluate_hand(player.hole_cards, self.game_state.hand.board)
                result.player_seat = seat_no
                hand_results[seat_no] = result
                player.hand_ranking = result.ranking
                player.winning_cards = result.winning_hole_indices + result.winning_board_indices
        
        # Build side pots
        side_pots = self._build_side_pots()
        
        # Determine winners for each pot
        winners = []
        for pot_idx, pot in enumerate(side_pots):
            eligible_results = {seat: hand_results[seat] for seat in pot.eligible_seats if seat in hand_results}
            if eligible_results:
                best_ranking = max(result.ranking for result in eligible_results.values())
                pot_winners = [seat for seat, result in eligible_results.items() 
                             if result.ranking == best_ranking]
                
                amount_per_winner = pot.amount // len(pot_winners)
                for winner_seat in pot_winners:
                    winner = Winner(
                        seat_no=winner_seat,
                        amount_won=amount_per_winner,
                        hand_result=hand_results[winner_seat],
                        pot_index=pot_idx
                    )
                    winners.append(winner)
                    
                    # Award pot to winner's stack
                    self.game_state.seats[winner_seat].stack += amount_per_winner
                    
                    events.append(Event(
                        event_type=EventType.POT_AWARDED,
                        data={
                            "seat_no": winner_seat,
                            "amount": amount_per_winner,
                            "pot_index": pot_idx,
                            "hand_result": dataclasses.asdict(hand_results[winner_seat])
                        }
                    ))
        
        self.game_state.hand.winners = winners
        
        events.append(Event(
            event_type=EventType.HAND_COMPLETE,
            data={
                "winners": [dataclasses.asdict(w) for w in winners],
                "hand_results": {seat: dataclasses.asdict(result) for seat, result in hand_results.items()}
            }
        ))
        
        # Advance dealer for next hand
        self.game_state.dealer_position = (self.game_state.dealer_position + 1) % len(self.game_state.seats)
        
        # Clear hand state
        self.game_state.hand = None
        
        return events
    
    # Helper methods
    def _deal_card(self) -> Tuple[int, str]:
        """Deal next card from deck"""
        if not self.game_state.hand or self.game_state.hand.cards_dealt >= len(self.game_state.hand.deck):
            # Fallback card if deck is exhausted (shouldn't happen in normal play)
            return (2, "S")
        
        card = self.game_state.hand.deck[self.game_state.hand.cards_dealt]
        self.game_state.hand.cards_dealt += 1
        return card
    
    def _burn_card(self):
        """Burn (discard) next card from deck"""
        if self.game_state.hand and self.game_state.hand.cards_dealt < len(self.game_state.hand.deck):
            self.game_state.hand.cards_dealt += 1

    def _next_active_seat(self, from_seat: int) -> Optional[int]:
        """Find next active seat after given seat"""
        for i in range(1, len(self.game_state.seats)):
            seat_no = (from_seat + i) % len(self.game_state.seats)
            seat = self.game_state.seats[seat_no]
            if seat.user_id and seat.stack > 0 and not seat.is_sitting_out:
                return seat_no
        return None
    
    def _next_active_player(self, from_seat: int) -> Optional[int]:
        """Find next active player in current hand"""
        if not self.game_state.hand:
            return None
        
        for i in range(1, len(self.game_state.seats)):
            seat_no = (from_seat + i) % len(self.game_state.seats)
            if seat_no in self.game_state.hand.players:
                player = self.game_state.hand.players[seat_no]
                if not player.has_folded and not player.is_all_in:
                    return seat_no
        return None
    
    def _post_blind(self, seat_no: int, amount: int):
        """Post blind bet"""
        if self.game_state.hand and seat_no in self.game_state.hand.players:
            self._make_bet(seat_no, amount)
    
    def _make_bet(self, seat_no: int, amount: int):
        """Make a bet, handling all-in situations"""
        seat = self.game_state.seats[seat_no]
        player = self.game_state.hand.players[seat_no]
        
        actual_amount = min(amount, seat.stack)
        seat.stack -= actual_amount
        player.street_contribution += actual_amount
        player.total_contribution += actual_amount
        
        if seat.stack == 0:
            player.is_all_in = True
    
    def _get_to_call(self, seat_no: int) -> int:
        """Get amount player needs to call"""
        if not self.game_state.hand or seat_no not in self.game_state.hand.players:
            return 0
        
        player = self.game_state.hand.players[seat_no]
        return max(0, self.game_state.hand.current_bet - player.street_contribution)
    
    def _is_betting_complete(self) -> bool:
        """Check if betting round is complete"""
        if not self.game_state.hand:
            return True
        
        active_players = [p for p in self.game_state.hand.players.values() 
                         if not p.has_folded and not p.is_all_in]
        
        if len(active_players) <= 1:
            return True
        
        # All active players must have same street contribution
        target_bet = self.game_state.hand.current_bet
        for player in active_players:
            if player.street_contribution < target_bet:
                return False
        
        return True
    
    def _build_side_pots(self) -> List[SidePot]:
        """Build side pots for all-in situations"""
        if not self.game_state.hand:
            return []
        
        # Get all contribution levels
        contributions = {}
        for seat_no, player in self.game_state.hand.players.items():
            contributions[seat_no] = player.total_contribution
        
        if not contributions:
            return []
        
        # Sort by contribution amount
        sorted_contributions = sorted(set(contributions.values()))
        side_pots = []
        
        prev_level = 0
        for level in sorted_contributions:
            eligible_seats = [seat for seat, contrib in contributions.items() if contrib >= level]
            pot_amount = len(eligible_seats) * (level - prev_level)
            
            if pot_amount > 0:
                side_pots.append(SidePot(
                    amount=pot_amount,
                    eligible_seats=eligible_seats
                ))
            
            prev_level = level
        
        return side_pots

# --------- WebSocket Connection Management ---------
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, List[WebSocket]] = {}
        self.state_machines: Dict[str, PokerStateMachine] = {}
    
    async def connect(self, websocket: WebSocket, table_id: str):
        await websocket.accept()
        if table_id not in self.active_connections:
            self.active_connections[table_id] = []
            # Create state machine for new table
            config = TableConfig(
                table_id=table_id,
                name="Main Table",
                max_seats=6,
                small_blind=50,
                big_blind=100,
                min_buy_in=2000,
                max_buy_in=20000
            )
            self.state_machines[table_id] = PokerStateMachine(config)
        
        self.active_connections[table_id].append(websocket)
    
    def disconnect(self, websocket: WebSocket, table_id: str):
        if table_id in self.active_connections:
            self.active_connections[table_id].remove(websocket)
    
    async def send_personal_message(self, message: dict, websocket: WebSocket):
        await websocket.send_json(message)
    
    async def broadcast(self, message: dict, table_id: str):
        if table_id in self.active_connections:
            for connection in self.active_connections[table_id]:
                try:
                    await connection.send_json(message)
                except:
                    pass
    
    def seat_player(self, table_id: str, seat_no: int, user_id: int, username: str, buy_in_amount: int) -> bool:
        """Seat a player at the table"""
        if table_id not in self.state_machines:
            return False
        
        state_machine = self.state_machines[table_id]
        game_state = state_machine.game_state
        
        # Validate seat number
        if seat_no < 0 or seat_no >= len(game_state.seats):
            return False
        
        seat = game_state.seats[seat_no]
        
        # Check if seat is available
        if seat.user_id is not None:
            return False
        
        # Validate buy-in amount
        if buy_in_amount < state_machine.config.min_buy_in or buy_in_amount > state_machine.config.max_buy_in:
            return False
        
        # Seat the player
        seat.user_id = user_id
        seat.username = username
        seat.stack = buy_in_amount
        seat.is_sitting_out = False
        seat.is_connected = True
        
        return True
    
    def unseat_player(self, table_id: str, user_id: int) -> bool:
        """Remove a player from their seat"""
        if table_id not in self.state_machines:
            return False
        
        state_machine = self.state_machines[table_id]
        game_state = state_machine.game_state
        
        # Find player's seat
        player_seat = None
        for seat in game_state.seats:
            if seat.user_id == user_id:
                player_seat = seat
                break
        
        if not player_seat:
            return False
        
        # Don't allow leaving during active hand if player is involved
        if game_state.hand and player_seat.seat_no in game_state.hand.players:
            player = game_state.hand.players[player_seat.seat_no]
            if not player.has_folded:
                return False  # Can't leave while in active hand
        
        # Clear the seat
        player_seat.user_id = None
        player_seat.username = None
        player_seat.stack = 0
        player_seat.is_sitting_out = False
        player_seat.is_connected = False
        
        return True

    def _serialize_hand_state(self, hand_state: HandState) -> Dict[str, Any]:
        """Serialize HandState to dict, handling bytes fields properly"""
        hand_dict = dataclasses.asdict(hand_state)
        
        # Convert bytes field to base64 or remove it (we don't need to send it to client)
        if 'deck_seed' in hand_dict:
            del hand_dict['deck_seed']  # Remove sensitive seed data
        
        # Remove full deck info (too much data, client doesn't need it)
        if 'deck' in hand_dict:
            del hand_dict['deck']
            
        return hand_dict

    async def send_game_state(self, table_id: str, websocket: WebSocket = None, user_id: int = None):
        """Send complete game state to client(s)"""
        if table_id not in self.state_machines:
            return
        
        state_machine = self.state_machines[table_id]
        game_state = state_machine.game_state
        
        # Build state message
        state_msg = {
            "type": EventType.GAME_STATE.value,
            "table": {
                "id": game_state.table_id,
                "name": state_machine.config.name,
                "max_seats": state_machine.config.max_seats,
                "small_blind": state_machine.config.small_blind,
                "big_blind": state_machine.config.big_blind,
                "min_buy_in": state_machine.config.min_buy_in,
                "max_buy_in": state_machine.config.max_buy_in
            },
            "seats": [dataclasses.asdict(seat) for seat in game_state.seats],
            "hand": self._serialize_hand_state(game_state.hand) if game_state.hand else None,
            "dealer_position": game_state.dealer_position
        }
        
        # Add user-specific data (hole cards)
        if user_id and game_state.hand:
            user_seat = None
            for seat in game_state.seats:
                if seat.user_id == user_id:
                    user_seat = seat.seat_no
                    break
            
            if user_seat is not None and user_seat in game_state.hand.players:
                player = game_state.hand.players[user_seat]
                state_msg["your_seat"] = user_seat
                state_msg["hole_cards"] = player.hole_cards
        
        if websocket:
            await self.send_personal_message(state_msg, websocket)
        else:
            await self.broadcast(state_msg, table_id)

manager = ConnectionManager()

# --------- API Routes ---------
@router.get("/tables", response_model=List[TableSummary])
async def get_tables():
    """Get list of available tables"""
    return [
        TableSummary(
            id="main",
            name="Main Table",
            isPrivate=False,
            smallBlind=50,
            bigBlind=100,
            minBuyIn=2000,
            maxBuyIn=20000,
            maxSeats=6,
            seatsTaken=0,
            status="waiting"
        )
    ]

@router.post("/join")
async def join_table(data: dict, user: User = Depends(current_user)):
    """Join a poker table"""
    table_id = data.get("tableId", "main")
    # Table joining logic would go here
    return {"success": True}

@router.websocket("/ws/{table_id}")
async def websocket_endpoint(websocket: WebSocket, table_id: str, db: Session = Depends(get_db)):
    """WebSocket endpoint for real-time poker gameplay"""
    await manager.connect(websocket, table_id)
    
    # Authenticate user from cookie
    from jose import jwt, JWTError
    from ..security import JWT_SECRET, JWT_ALG, COOKIE_NAME
    from ..models import User
    
    token = websocket.cookies.get(COOKIE_NAME)
    if not token:
        await websocket.close(code=4401)
        return
    try:
        data = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
        uid = int(data["sub"])
    except JWTError:
        await websocket.close(code=4401)
        return
    user = db.query(User).get(uid)
    if not user or not user.is_active:
        await websocket.close(code=4401)
        return
    
    # Send initial game state
    await manager.send_game_state(table_id, websocket)
    
    try:
        while True:
            data = await websocket.receive_json()
            message_type = data.get("type")
            
            if message_type == "PLAYER_ACTION":
                # Process player action through state machine
                action = PlayerAction(
                    seat_no=data.get("seat_no", 0),
                    action=ActionType(data.get("action", "fold")),
                    amount=data.get("amount", 0)
                )
                
                state_machine = manager.state_machines.get(table_id)
                if state_machine:
                    events = state_machine.process_action(action.seat_no, action)
                    
                    # Broadcast events to all clients
                    for event in events:
                        await manager.broadcast({
                            "type": event.event_type.value,
                            "data": event.data,
                            "timestamp": event.timestamp
                        }, table_id)
                    
                    # Send updated game state
                    await manager.send_game_state(table_id)
            
            elif message_type == "START_GAME":
                # Start new hand
                state_machine = manager.state_machines.get(table_id)
                if state_machine:
                    # Check if we have enough players
                    active_seats = [s for s in state_machine.game_state.seats 
                                   if s.user_id and s.stack > 0 and not s.is_sitting_out]
                    
                    if len(active_seats) < 2:
                        await websocket.send_json({
                            "type": "ERROR", 
                            "data": {"message": "Need at least 2 players to start a game"}
                        })
                        continue
                    
                    # Check if there's already a hand in progress
                    if state_machine.game_state.hand is not None:
                        await websocket.send_json({
                            "type": "ERROR", 
                            "data": {"message": "Game is already in progress"}
                        })
                        continue
                    
                    events = state_machine.start_hand()
                    
                    for event in events:
                        await manager.broadcast({
                            "type": event.event_type.value,
                            "data": event.data,
                            "timestamp": event.timestamp
                        }, table_id)
                    
                    await manager.send_game_state(table_id)
            
            elif message_type == "TAKE_SEAT":
                # Player wants to sit down
                seat_no = data.get("seat_no")
                buy_in_amount = data.get("buy_in_amount", 0)  # in cents
                
                # Check if user has sufficient balance
                if user.balance_cents < buy_in_amount:
                    await websocket.send_json({
                        "type": "ERROR", 
                        "data": {"message": "Insufficient balance"}
                    })
                    continue
                
                state_machine = manager.state_machines.get(table_id)
                if state_machine and seat_no is not None:
                    success = manager.seat_player(table_id, seat_no, user.id, user.username, buy_in_amount)
                    
                    if success:
                        # Deduct buy-in from user balance and log transaction
                        user.balance_cents -= buy_in_amount
                        
                        # Log the buy-in transaction
                        db.add(Transaction(
                            user_id=user.id, 
                            session_id=None,  # No session ID for poker buy-ins
                            amount_cents=-buy_in_amount, 
                            kind="poker_buyin"
                        ))
                        db.commit()
                        
                        await manager.send_game_state(table_id)
                        await websocket.send_json({
                            "type": "SEAT_TAKEN",
                            "data": {"seat_no": seat_no, "success": True}
                        })
                    else:
                        await websocket.send_json({
                            "type": "ERROR", 
                            "data": {"message": "Could not take seat"}
                        })
            
            elif message_type == "LEAVE_SEAT":
                # Player wants to stand up
                state_machine = manager.state_machines.get(table_id)
                if state_machine:
                    # Get current seat to return chips
                    current_seat = None
                    for seat in state_machine.game_state.seats.values():
                        if seat.player_id == user.id:
                            current_seat = seat
                            break
                    
                    success = manager.unseat_player(table_id, user.id)
                    
                    if success:
                        # Return chips to user balance and log transaction
                        if current_seat and current_seat.chips > 0:
                            user.balance_cents += current_seat.chips
                            
                            # Log the cash-out transaction
                            db.add(Transaction(
                                user_id=user.id, 
                                session_id=None,  # No session ID for poker cash-outs
                                amount_cents=current_seat.chips, 
                                kind="poker_cashout"
                            ))
                            db.commit()
                        
                        await manager.send_game_state(table_id)
                        await websocket.send_json({
                            "type": "SEAT_LEFT",
                            "data": {"success": True}
                        })
                    else:
                        await websocket.send_json({
                            "type": "ERROR", 
                            "data": {"message": "Could not leave seat"}
                        })
    
    except WebSocketDisconnect:
        manager.disconnect(websocket, table_id)