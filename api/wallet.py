import os
from secrets import compare_digest
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from .security import current_user, get_db
from .models import Transaction
from .schemas import DepositIn

router = APIRouter(prefix="/wallet", tags=["wallet"])

@router.get("/balance")
def balance(user = Depends(current_user)):
    return {"balance_cents": user.balance_cents}

@router.get("/summary")
def summary(user = Depends(current_user), db: Session = Depends(get_db)):
    total_bet = db.query(func.sum(Transaction.amount_cents)).filter(
        Transaction.user_id==user.id, Transaction.kind=="bet"
    ).scalar() or 0
    total_payout = db.query(func.sum(Transaction.amount_cents)).filter(
        Transaction.user_id==user.id, Transaction.kind.in_(["payout","refund"])
    ).scalar() or 0
    return {
        "total_bet_cents": int(abs(total_bet)),
        "total_return_cents": int(total_payout),
        "net_cents": int(total_payout + total_bet)  # bet is negative
    }

@router.post("/deposit")
def deposit(body: DepositIn, user = Depends(current_user), db: Session = Depends(get_db)):
    amount = int(body.amount_cents)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="amount_cents must be > 0")
    # Re-auth check against server-configured deposit password
    # Accept both uppercase and lowercase for convenience (.env vs platform env)
    expected = os.getenv("DEPOSIT_PASSWORD") or os.getenv("deposit_password")
    if not expected:
        # Do not allow deposits if password isn't configured server-side
        raise HTTPException(status_code=500, detail="Deposit password not configured")
    if not compare_digest(body.password, expected):
        raise HTTPException(status_code=401, detail="Invalid password")
    # Record transaction and update balance
    txn = Transaction(user_id=user.id, amount_cents=amount, kind="deposit")
    db.add(txn)
    user.balance_cents = int((user.balance_cents or 0) + amount)
    db.add(user)
    db.commit()
    db.refresh(user)
    return { "balance_cents": user.balance_cents }
