import os, random, datetime as dt, secrets, hashlib
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from ..security import current_user, get_db
from ..models import User, GameSession, GameType, Transaction, RouletteSpin
from ..schemas import (
    RouletteStartIn,
    RouletteStartOut,
    RouletteSettleIn,
    RouletteSettleOut,
    RoulettePayout,
    RouletteWheelConfig,
)

router = APIRouter(prefix="/roulette", tags=["roulette"])

# European single-zero pocket order clockwise starting from 0 at top
EURO_POCKETS = [
    "0",
    "32","15","19","4","21","2","25","17","34","6","27","13","36","11","30","8","23",
    "10","5","24","16","33","1","20","14","31","9","22","18","29","7","28","12","35","3","26",
]
WHEEL = [str(n) for n in range(0, 37)]  # valid labels
COLORS = { "0": "G", **{str(n):("R" if n in {1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36} else "B") for n in range(1,37)} }
STEP = 2 * 3.141592653589793 / len(EURO_POCKETS)
ASSET_OFFSET_RAD = 0.0

def make_commit(seed: str, target: str) -> str:
    # Use SHA-256 of seed:target so client can verify when seed is revealed
    data = f"{seed}:{target}".encode("utf-8")
    return hashlib.sha256(data).hexdigest()

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


@router.post("/start", response_model=RouletteStartOut)
def start(body: RouletteStartIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not body.bets:
        raise HTTPException(400, "No bets provided")
    # Validate bets and compute total
    total = 0
    for b in body.bets:
        if b.amount_cents <= 0:
            raise HTTPException(400, "Bet amounts must be positive")
        if b.type == "straight":
            if b.target not in WHEEL:
                raise HTTPException(400, f"Invalid number {b.target}")
        elif b.type == "color":
            if b.target not in ("R", "B"):
                raise HTTPException(400, "Color bet must be 'R' or 'B'")
        elif b.type == "even":
            if b.target.upper() != "EVEN":
                raise HTTPException(400, "Even bet target must be 'EVEN'")
        elif b.type == "odd":
            if b.target.upper() != "ODD":
                raise HTTPException(400, "Odd bet target must be 'ODD'")
        elif b.type == "low":
            if b.target.upper() != "LOW":
                raise HTTPException(400, "Low bet target must be 'LOW'")
        elif b.type == "high":
            if b.target.upper() != "HIGH":
                raise HTTPException(400, "High bet target must be 'HIGH'")
        elif b.type == "dozen":
            if b.target not in ("1","2","3"):
                raise HTTPException(400, "Dozen bet target must be '1','2','3'")
        elif b.type == "column":
            if b.target not in ("1","2","3"):
                raise HTTPException(400, "Column bet target must be '1','2','3'")
        else:
            raise HTTPException(400, f"Unsupported bet type {b.type}")
        total += int(b.amount_cents)

    if user.balance_cents < total:
        raise HTTPException(400, "Insufficient balance")

    # Debit once for the whole set of bets
    db.add(Transaction(user_id=user.id, amount_cents=-total, kind="bet"))
    user.balance_cents -= total

    # Create a session to represent this spin
    s = GameSession(user_id=user.id, game_type=GameType.roulette, bet_cents=total, state={"bets": [b.dict() for b in body.bets], "tableId": body.tableId})
    db.add(s); db.flush()

    # Authority: choose target and commit
    target = random.choice(WHEEL)
    seed = secrets.token_hex(16)
    commit = make_commit(seed, target)

    # Persist the commitment data in session state; reveal seed on settle
    st = s.state or {}
    st.update({"targetNumber": target, "commitHash": commit, "seed": seed, "status": "committed"})
    s.state = st

    # Track spin analytics
    color = COLORS[target]
    db.add(RouletteSpin(session_id=s.id, result=f"{target}{color}"))
    db.commit()

    # Provide wheel layout config for the client animation
    cfg = RouletteWheelConfig(pockets=EURO_POCKETS, step=STEP, assetOffsetRad=ASSET_OFFSET_RAD, clockwise=True)
    return RouletteStartOut(targetNumber=target, commitHash=commit, spinId=s.id, wheelConfig=cfg)


@router.post("/settle", response_model=RouletteSettleOut)
def settle(body: RouletteSettleIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    # Load session and basic guards
    s = db.query(GameSession).get(body.spinId)
    if not s or s.user_id != user.id or s.game_type != GameType.roulette:
        raise HTTPException(404, "Spin not found")
    state = s.state or {}
    target = state.get("targetNumber")
    seed = state.get("seed")
    # Graceful fallback: if missing, recover from logged spin row
    if not target:
        rs = db.query(RouletteSpin).filter(RouletteSpin.session_id == s.id).order_by(RouletteSpin.id.desc()).first()
        if rs and isinstance(rs.result, str):
            # result like "17B" or "0G"; strip trailing letter(s) to get number
            tgt = ''.join(ch for ch in rs.result if ch.isdigit())
            if tgt in WHEEL:
                target = tgt
    if not target:
        raise HTTPException(400, "Spin not initialized correctly")
    if seed is None:
        # best-effort: seed might be absent for legacy rows
        seed = ""

    # Calculate payouts per bet (multiples include returning stake)
    bets = state.get("bets", [])
    payouts: list[RoulettePayout] = []
    total_credit = 0
    color = COLORS.get(target)
    for b in bets:
        sel = b.get("target")
        amt = int(b.get("amount_cents", 0))
        btype = b.get("type")
        win_amount = 0
        multiple = 0.0
        if btype == "straight":
            multiple = 36.0
            if sel == target:
                win_amount = int(amt * multiple)
        elif btype == "color":
            multiple = 2.0
            if color in ("R","B") and sel == color and target != "0":
                win_amount = int(amt * multiple)
        elif btype == "even":
            multiple = 2.0
            try:
                n = int(target)
                if n != 0 and (n % 2 == 0):
                    win_amount = int(amt * multiple)
            except Exception:
                pass
        elif btype == "odd":
            multiple = 2.0
            try:
                n = int(target)
                if n % 2 == 1:
                    win_amount = int(amt * multiple)
            except Exception:
                pass
        elif btype == "low":
            multiple = 2.0
            try:
                n = int(target)
                if 1 <= n <= 18:
                    win_amount = int(amt * multiple)
            except Exception:
                pass
        elif btype == "high":
            multiple = 2.0
            try:
                n = int(target)
                if 19 <= n <= 36:
                    win_amount = int(amt * multiple)
            except Exception:
                pass
        elif btype == "dozen":
            multiple = 3.0
            try:
                n = int(target)
                dz = int(sel)
                if (dz == 1 and 1 <= n <= 12) or (dz == 2 and 13 <= n <= 24) or (dz == 3 and 25 <= n <= 36):
                    win_amount = int(amt * multiple)
            except Exception:
                pass
        elif btype == "column":
            multiple = 3.0
            try:
                n = int(target)
                col = int(sel)
                mod = 1 if col == 1 else 2 if col == 2 else 0
                if (n % 3) == mod:
                    win_amount = int(amt * multiple)
            except Exception:
                pass
        payouts.append(RoulettePayout(selection=f"{btype}:{sel}", amount_wagered=amt, multiple=multiple, win_amount=win_amount))
        total_credit += win_amount

    # Credit winnings if any
    if total_credit > 0:
        db.add(Transaction(user_id=user.id, session_id=s.id, amount_cents=total_credit, kind="payout"))
        user.balance_cents += total_credit

    # Mark session settled
    s.outcome = "win" if total_credit > 0 else "lose"
    s.payout_cents = total_credit
    s.status = "settled"
    s.ended_at = dt.datetime.utcnow()
    s.state = {**state, "status": "settled"}
    db.commit()

    return RouletteSettleOut(payouts=payouts, newBalance=user.balance_cents, seed=seed)


# Convenience GET wrapper for environments that mistakenly call settle via GET
@router.get("/settle", response_model=RouletteSettleOut)
def settle_get(spinId: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return settle(RouletteSettleIn(spinId=spinId), user, db)
