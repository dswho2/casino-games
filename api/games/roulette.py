import random, datetime as dt
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..security import current_user, get_db
from ..models import User, GameSession, GameType, Transaction, RouletteSpin

router = APIRouter(prefix="/roulette", tags=["roulette"])

WHEEL = [str(n) for n in range(0, 37)]  # simple 0..36
COLORS = { "0": "G", **{str(n):("R" if n in {1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36} else "B") for n in range(1,37)} }

@router.post("/spin")
def spin(bet_cents: int, bet_target: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if bet_cents <= 0: raise HTTPException(400, "Bet must be positive")
    if user.balance_cents < bet_cents: raise HTTPException(400, "Insufficient balance")

    db.add(Transaction(user_id=user.id, amount_cents=-bet_cents, kind="bet"))
    user.balance_cents -= bet_cents

    s = GameSession(user_id=user.id, game_type=GameType.roulette, bet_cents=bet_cents, state={"bet_target": bet_target})
    db.add(s); db.flush()

    result_num = random.choice(WHEEL)
    color = COLORS[result_num]
    result_label = f"{result_num}{color}"
    db.add(RouletteSpin(session_id=s.id, result=result_label))

    payout = 0
    if bet_target in ["R","B"]:
        win = (bet_target == color) and result_num != "0"
        payout = bet_cents * 2 if win else 0
    elif bet_target in WHEEL:
        win = (bet_target == result_num)
        payout = bet_cents * 36 if win else 0
    else:
        win = False

    if payout > 0:
        db.add(Transaction(user_id=user.id, session_id=s.id, amount_cents=payout, kind="payout"))
        user.balance_cents += payout
        s.outcome = "win"; s.payout_cents = payout
    else:
        s.outcome = "lose"; s.payout_cents = 0

    s.status = "settled"; s.ended_at = dt.datetime.utcnow()
    s.state["result"] = result_label
    db.commit()
    return {"session_id": s.id, "result": result_label, "payout_cents": payout, "balance_cents": user.balance_cents}
