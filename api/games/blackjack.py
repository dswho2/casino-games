import random, datetime as dt
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from . import __init__  # noqa
from ..schemas import BlackjackSessionOut
from ..security import current_user, get_db
from ..models import User, GameSession, GameType, Transaction, CardDraw, Outcome

router = APIRouter(prefix="/blackjack", tags=["blackjack"])

RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"]
SUITS = ["S","H","D","C"]

def new_shuffled_deck():
    deck = [{"r": r, "s": s} for r in RANKS for s in SUITS]
    random.shuffle(deck); return deck

def hand_value(cards):
    total = 0; aces = 0
    for c in cards:
        r = c["r"]
        if r in ["J","Q","K","10"]: total += 10
        elif r == "A": total += 11; aces += 1
        else: total += int(r)
    while total > 21 and aces: total -= 10; aces -= 1
    soft = aces > 0
    return total, soft

def settle(db, user: User, sess: GameSession):
    if sess.outcome in [Outcome.win.value, Outcome.blackjack.value]:
        if sess.outcome == "blackjack":
            credit = int(sess.bet_cents * 2.5)  # original bet plus 3:2
        else:
            credit = sess.bet_cents * 2
        db.add(Transaction(user_id=user.id, session_id=sess.id, amount_cents=credit, kind="payout"))
        user.balance_cents += credit
        sess.payout_cents = credit
    elif sess.outcome == Outcome.push.value:
        db.add(Transaction(user_id=user.id, session_id=sess.id, amount_cents=sess.bet_cents, kind="refund"))
        user.balance_cents += sess.bet_cents
        sess.payout_cents = sess.bet_cents
    else:
        sess.payout_cents = 0
    sess.status = "settled"
    sess.ended_at = dt.datetime.utcnow()

def to_out(user: User, s: GameSession) -> BlackjackSessionOut:
    p = s.state["player_hand"]["cards"]
    d = s.state["dealer_hand"]["cards"]
    pv, psoft = hand_value(p)
    dv, dsoft = hand_value(d)
    return BlackjackSessionOut(
        id=s.id, status=s.status, bet_cents=s.bet_cents,
        dealer_hand={"cards": d, "value": dv, "soft": dsoft},
        player_hand={"cards": p, "value": pv, "soft": psoft},
        outcome=s.outcome, payout_cents=s.payout_cents, balance_cents=user.balance_cents
    )

@router.post("/start", response_model=BlackjackSessionOut)
def start(bet_cents: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if bet_cents <= 0: raise HTTPException(400, "Bet must be positive")
    if user.balance_cents < bet_cents: raise HTTPException(400, "Insufficient balance")

    deck = new_shuffled_deck()
    p = [deck.pop(), deck.pop()]
    d = [deck.pop(), deck.pop()]

    db.add(Transaction(user_id=user.id, amount_cents=-bet_cents, kind="bet"))
    user.balance_cents -= bet_cents

    sess = GameSession(
        user_id=user.id, game_type=GameType.blackjack, bet_cents=bet_cents,
        state={"deck": deck, "player_hand": {"cards": p}, "dealer_hand": {"cards": d}}
    )
    db.add(sess); db.flush()

    draws = [
        CardDraw(session_id=sess.id, who="player", rank=p[0]["r"], suit=p[0]["s"], order_idx=0),
        CardDraw(session_id=sess.id, who="dealer", rank=d[0]["r"], suit=d[0]["s"], order_idx=1),
        CardDraw(session_id=sess.id, who="player", rank=p[1]["r"], suit=p[1]["s"], order_idx=2),
        CardDraw(session_id=sess.id, who="dealer", rank=d[1]["r"], suit=d[1]["s"], order_idx=3),
    ]
    db.add_all(draws)

    pv,_ = hand_value(p); dv,_ = hand_value(d)
    if pv == 21 and dv == 21:
        sess.outcome = Outcome.push.value; settle(db, user, sess)
    elif pv == 21:
        sess.outcome = Outcome.blackjack.value; settle(db, user, sess)

    db.commit(); db.refresh(sess)
    return to_out(user, sess)

@router.post("/action", response_model=BlackjackSessionOut)
def action(session_id: int, action: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    s = db.query(GameSession).filter(GameSession.id==session_id, GameSession.user_id==user.id, GameSession.game_type==GameType.blackjack).first()
    if not s or s.status != "in_progress":
        raise HTTPException(400, "Session not found or settled")

    deck = s.state["deck"]; p = s.state["player_hand"]["cards"]; d = s.state["dealer_hand"]["cards"]

    def draw(who: str):
        card = deck.pop()
        order = len(p)+len(d)
        db.add(CardDraw(session_id=s.id, who=who, rank=card["r"], suit=card["s"], order_idx=order))
        return card

    if action == "hit":
        p.append(draw("player"))
    elif action == "double":
        if len(p) != 2: raise HTTPException(400, "Double only on first move")
        if user.balance_cents < s.bet_cents: raise HTTPException(400, "Insufficient balance")
        db.add(Transaction(user_id=user.id, session_id=s.id, amount_cents=-s.bet_cents, kind="bet"))
        user.balance_cents -= s.bet_cents
        s.bet_cents *= 2
        p.append(draw("player"))
    elif action == "stand":
        pass
    elif action == "surrender":
        if len(p) != 2: raise HTTPException(400, "Surrender only on first move")
        refund = s.bet_cents // 2
        db.add(Transaction(user_id=user.id, session_id=s.id, amount_cents=refund, kind="refund"))
        user.balance_cents += refund
        s.outcome = Outcome.surrender.value
        settle(db, user, s)
        db.commit(); db.refresh(s)
        return to_out(user, s)
    else:
        raise HTTPException(400, "Unknown action")

    pv,_ = hand_value(p)
    s.state["player_hand"]["cards"] = p
    s.state["deck"] = deck
    s.actions_log.append(action)

    if pv > 21:
        s.outcome = Outcome.lose.value
        settle(db, user, s)
    elif action in ["stand","double"]:
        while True:
            dv, dsoft = hand_value(d)
            if dv < 17 or (dv == 17 and dsoft):
                d.append(draw("dealer"))
            else:
                break
        s.state["dealer_hand"]["cards"] = d
        dv,_ = hand_value(d); pv,_ = hand_value(p)
        if dv > 21 or pv > dv: s.outcome = Outcome.win.value
        elif pv < dv: s.outcome = Outcome.lose.value
        else: s.outcome = Outcome.push.value
        settle(db, user, s)

    db.commit(); db.refresh(s)
    return to_out(user, s)
