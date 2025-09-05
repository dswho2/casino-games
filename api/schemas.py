from pydantic import BaseModel, EmailStr, Field
from typing import Optional, Literal, List

class UserOut(BaseModel):
    id: int
    username: str
    balance_cents: int
    email: Optional[EmailStr] = None

class RegisterIn(BaseModel):
    username: str
    password: str
    email: Optional[EmailStr] = None

class LoginIn(BaseModel):
    identifier: str
    password: str

class StartSessionIn(BaseModel):
    game_type: Literal["blackjack","roulette","slots"]
    bet_cents: int

class ActionIn(BaseModel):
    session_id: int
    action: str  # per game action token

# Blackjack views
class Hand(BaseModel):
    cards: list
    value: int
    soft: bool

class BlackjackSessionOut(BaseModel):
    id: int
    status: str
    bet_cents: int
    dealer_hand: Hand
    player_hand: Hand
    player_hands: Optional[List[Hand]] = None
    active_index: Optional[int] = None
    outcome: Optional[str] = None
    payout_cents: Optional[int] = None
    balance_cents: int
    shoe_reshuffled: Optional[bool] = None
