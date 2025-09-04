from sqlalchemy import (
    Integer, String, DateTime, func, ForeignKey, Boolean, BigInteger, JSON, Enum
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from enum import Enum as PyEnum
from .db import Base

class GameType(PyEnum):
    blackjack = "blackjack"
    roulette = "roulette"
    slots = "slots"

class Outcome(PyEnum):
    win = "win"
    lose = "lose"
    push = "push"
    blackjack = "blackjack"
    surrender = "surrender"

class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    balance_cents: Mapped[int] = mapped_column(BigInteger, default=10000)

    sessions = relationship("GameSession", back_populates="user", cascade="all, delete-orphan")
    txns = relationship("Transaction", back_populates="user", cascade="all, delete-orphan")

class GameSession(Base):
    __tablename__ = "game_sessions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    game_type: Mapped[Enum] = mapped_column(Enum(GameType))
    status: Mapped[str] = mapped_column(String(20), index=True, default="in_progress")
    bet_cents: Mapped[int] = mapped_column(BigInteger)
    started_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ended_at: Mapped[DateTime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    state: Mapped[dict] = mapped_column(JSON, default={})  # per game state blob
    actions_log: Mapped[list] = mapped_column(JSON, default=[])
    outcome: Mapped[str | None] = mapped_column(String(20), nullable=True)
    payout_cents: Mapped[int | None] = mapped_column(BigInteger, nullable=True)

    user = relationship("User", back_populates="sessions")

class Transaction(Base):
    __tablename__ = "transactions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    session_id: Mapped[int | None] = mapped_column(ForeignKey("game_sessions.id", ondelete="SET NULL"), nullable=True)
    amount_cents: Mapped[int] = mapped_column(BigInteger)
    kind: Mapped[str] = mapped_column(String(30))  # bet, payout, refund, bonus, deposit, withdraw
    created_at: Mapped[DateTime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User", back_populates="txns")

# Blackjack analytics
class CardDraw(Base):
    __tablename__ = "card_draws"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("game_sessions.id", ondelete="CASCADE"), index=True)
    who: Mapped[str] = mapped_column(String(10))  # player or dealer
    rank: Mapped[str] = mapped_column(String(2))
    suit: Mapped[str] = mapped_column(String(1))
    order_idx: Mapped[int] = mapped_column(Integer)

# Roulette analytics placeholder
class RouletteSpin(Base):
    __tablename__ = "roulette_spins"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("game_sessions.id", ondelete="CASCADE"), index=True)
    result: Mapped[str] = mapped_column(String(8))  # e.g. "17B", "0G"
