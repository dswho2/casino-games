from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from .security import current_user, get_db
from .models import Transaction

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
