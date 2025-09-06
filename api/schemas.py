from pydantic import BaseModel, EmailStr, Field
from typing import Optional, Literal, List, Union

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

# Wallet
class DepositIn(BaseModel):
  amount_cents: int = Field(gt=0, description="Positive amount in cents to deposit")
  password: str = Field(min_length=1, description="User password for re-authentication")
  note: Optional[str] = None

# Roulette
class RouletteBet(BaseModel):
    # Extended set: accept outside bets natively
    # straight: target "0".."36"
    # color: target "R" or "B"
    # even/odd: target "EVEN" / "ODD"
    # low/high: target "LOW" / "HIGH"
    # dozen: target "1" | "2" | "3"
    # column: target "1" | "2" | "3"
    type: Literal["straight", "color", "even", "odd", "low", "high", "dozen", "column"]
    target: str
    amount_cents: int = Field(gt=0)

class RouletteStartIn(BaseModel):
    tableId: Optional[str] = "main"
    bets: List[RouletteBet]

class RouletteWheelConfig(BaseModel):
    pockets: List[str]
    step: float
    assetOffsetRad: float
    clockwise: bool | None = True

class RouletteStartOut(BaseModel):
    targetNumber: str
    commitHash: str
    spinId: int
    wheelConfig: RouletteWheelConfig

class RouletteSettleIn(BaseModel):
    spinId: int

class RoulettePayout(BaseModel):
    selection: str
    amount_wagered: int
    multiple: float
    win_amount: int

class RouletteSettleOut(BaseModel):
    payouts: List[RoulettePayout]
    newBalance: int
    seed: str
