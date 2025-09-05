import random
import datetime as dt
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from . import __init__  # noqa
from ..schemas import BlackjackSessionOut
from ..security import current_user, get_db
from ..models import User, GameSession, GameType, Transaction, CardDraw, Outcome

router = APIRouter(prefix="/blackjack", tags=["blackjack"])

RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
SUITS = ["S", "H", "D", "C"]

# Shoe configuration (can be made configurable via env later)
SHOE_DECKS = 6
PENETRATION_RANGE = (0.75, 0.80)  # reshuffle when ~75-80% of shoe has been used

# In-memory shoe storage per user_id
SHOES: dict[int, dict] = {}


def build_shoe(n_decks: int = SHOE_DECKS):
    cards = []
    for _ in range(n_decks):
        cards.extend({"r": r, "s": s} for r in RANKS for s in SUITS)
    random.shuffle(cards)
    total = len(cards)
    pen = random.uniform(*PENETRATION_RANGE)
    reshuffle_after_drawn = int(total * pen)
    cut_remaining = total - reshuffle_after_drawn
    return {"cards": cards, "total": total, "cut_remaining": cut_remaining, "n_decks": n_decks}

def ensure_shoe(user_id: int) -> tuple[dict, bool]:
    shoe = SHOES.get(user_id)
    reshuffled = False
    if shoe is None or len(shoe["cards"]) <= shoe["cut_remaining"]:
        shoe = build_shoe()
        SHOES[user_id] = shoe
        reshuffled = True
    return shoe, reshuffled

def draw_from_shoe(user_id: int) -> dict:
    # Draw without triggering reshuffle; reshuffle is decided at round start
    shoe = SHOES.get(user_id)
    if shoe is None or not shoe.get("cards"):
        shoe = build_shoe()
        SHOES[user_id] = shoe
    return shoe["cards"].pop()


def hand_value(cards):
    total = 0
    aces = 0
    for c in cards:
        r = c["r"]
        if r in ["J", "Q", "K", "10"]:
            total += 10
        elif r == "A":
            total += 11
            aces += 1
        else:
            total += int(r)
    while total > 21 and aces:
        total -= 10
        aces -= 1
    soft = aces > 0
    return total, soft


def settle(db, user: User, sess: GameSession):
    if sess.outcome in [Outcome.win.value, Outcome.blackjack.value]:
        if sess.outcome == "blackjack":
            credit = int(sess.bet_cents * 2.5)  # original bet plus 3:2
        else:
            credit = sess.bet_cents * 2
        db.add(
            Transaction(
                user_id=user.id, session_id=sess.id, amount_cents=credit, kind="payout"
            )
        )
        user.balance_cents += credit
        sess.payout_cents = credit
    elif sess.outcome == Outcome.push.value:
        db.add(
            Transaction(
                user_id=user.id,
                session_id=sess.id,
                amount_cents=sess.bet_cents,
                kind="refund",
            )
        )
        user.balance_cents += sess.bet_cents
        sess.payout_cents = sess.bet_cents
    else:
        sess.payout_cents = 0
    sess.status = "settled"
    sess.ended_at = dt.datetime.utcnow()


def to_out(user: User, s: GameSession) -> BlackjackSessionOut:
    state = s.state
    d = state["dealer_hand"]["cards"]
    dv, dsoft = hand_value(d)
    if "hands" in state:
        hands = state["hands"]
        active = state.get("active", 0)
        phands = []
        for h in hands:
            hv, hsoft = hand_value(h["cards"])
            phands.append({"cards": h["cards"], "value": hv, "soft": hsoft})
        current = (
            phands[active] if phands and 0 <= active < len(phands) else {"cards": [], "value": 0, "soft": False}
        )
        return BlackjackSessionOut(
            id=s.id,
            status=s.status,
            bet_cents=s.bet_cents,
            dealer_hand={"cards": d, "value": dv, "soft": dsoft},
            player_hand=current,
            player_hands=phands,
            active_index=active,
            outcome=s.outcome,
            payout_cents=s.payout_cents,
            balance_cents=user.balance_cents,
            shoe_reshuffled=bool(state.get("shoe_reshuffled", False)),
        )
    else:
        p = state["player_hand"]["cards"]
        pv, psoft = hand_value(p)
        return BlackjackSessionOut(
            id=s.id,
            status=s.status,
            bet_cents=s.bet_cents,
            dealer_hand={"cards": d, "value": dv, "soft": dsoft},
            player_hand={"cards": p, "value": pv, "soft": psoft},
            outcome=s.outcome,
            payout_cents=s.payout_cents,
            balance_cents=user.balance_cents,
            shoe_reshuffled=bool(state.get("shoe_reshuffled", False)),
        )


@router.post("/start", response_model=BlackjackSessionOut)
def start(
    bet_cents: int, user: User = Depends(current_user), db: Session = Depends(get_db)
):
    if bet_cents <= 0:
        raise HTTPException(400, "Bet must be positive")
    if user.balance_cents < bet_cents:
        raise HTTPException(400, "Insufficient balance")

    # Use multi-deck shoe; reshuffle between rounds if past cut
    shoe, reshuffled = ensure_shoe(user.id)
    p = [draw_from_shoe(user.id), draw_from_shoe(user.id)]
    d = [draw_from_shoe(user.id), draw_from_shoe(user.id)]

    # TODO: Consider attaching session_id to the initial bet transaction once sess.id is available (after flush)
    # and/or wrap bet + session creation atomically to avoid partial state on failures.
    db.add(Transaction(user_id=user.id, amount_cents=-bet_cents, kind="bet"))
    user.balance_cents -= bet_cents

    sess = GameSession(
        user_id=user.id,
        game_type=GameType.blackjack,
        bet_cents=bet_cents,
        state={
            "dealer_hand": {"cards": d},
            "hands": [
                {"cards": p, "bet": bet_cents, "done": False, "doubled": False}
            ],
            "active": 0,
            "shoe_reshuffled": reshuffled,
            "shoe_remaining": len(shoe["cards"]),
            "shoe_decks": shoe["n_decks"],
        },
    )
    db.add(sess)
    db.flush()

    draws = [
        CardDraw(
            session_id=sess.id, who="player", rank=p[0]["r"], suit=p[0]["s"], order_idx=0
        ),
        CardDraw(
            session_id=sess.id, who="dealer", rank=d[0]["r"], suit=d[0]["s"], order_idx=1
        ),
        CardDraw(
            session_id=sess.id, who="player", rank=p[1]["r"], suit=p[1]["s"], order_idx=2
        ),
        CardDraw(
            session_id=sess.id, who="dealer", rank=d[1]["r"], suit=d[1]["s"], order_idx=3
        ),
    ]
    db.add_all(draws)

    pv, _ = hand_value(p)
    dv, _ = hand_value(d)
    if pv == 21 and dv == 21:
        sess.outcome = Outcome.push.value
        settle(db, user, sess)
    elif pv == 21:
        sess.outcome = Outcome.blackjack.value
        settle(db, user, sess)

    db.commit()
    db.refresh(sess)
    return to_out(user, sess)


@router.post("/action", response_model=BlackjackSessionOut)
def action(
    session_id: int,
    action: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
):
    s = (
        db.query(GameSession)
        .filter(
            GameSession.id == session_id,
            GameSession.user_id == user.id,
            GameSession.game_type == GameType.blackjack,
        )
        .first()
    )
    if not s or s.status != "in_progress":
        raise HTTPException(400, "Session not found or settled")

    state = s.state
    # Upgrade old state shape (pre-split) to new multi-hand shape if needed
    if "hands" not in state:
        p0 = state["player_hand"]["cards"]
        state = {
            "dealer_hand": state["dealer_hand"],
            "hands": [{"cards": p0, "bet": s.bet_cents, "done": False, "doubled": False}],
            "active": 0,
        }

    # Draw from shoe directly (no per-session deck)
    d = list(state["dealer_hand"]["cards"])  # copy dealer hand
    hands = [
        {
            "cards": list(h["cards"]),
            "bet": int(h.get("bet", s.bet_cents)),
            "done": bool(h.get("done", False)),
            "doubled": bool(h.get("doubled", False)),
        }
        for h in state["hands"]
    ]
    active = int(state.get("active", 0))

    def draw(who: str):
        card = draw_from_shoe(user.id)
        order = sum(len(h["cards"]) for h in hands) + len(d)
        db.add(
            CardDraw(
                session_id=s.id,
                who=who,
                rank=card["r"],
                suit=card["s"],
                order_idx=order,
            )
        )
        return card

    def hv(cards):
        v, _ = hand_value(cards)
        return v

    if action == "hit":
        h = hands[active]
        h["cards"].append(draw("player"))
        if hv(h["cards"]) > 21:
            h["done"] = True
            # advance to next undone hand
            for idx in range(active + 1, len(hands)):
                if not hands[idx]["done"]:
                    active = idx
                    break
    elif action == "double":
        h = hands[active]
        if len(h["cards"]) != 2 or h["doubled"]:
            raise HTTPException(400, "Double only on first move")
        if user.balance_cents < h["bet"]:
            raise HTTPException(400, "Insufficient balance")
        db.add(
            Transaction(
                user_id=user.id, session_id=s.id, amount_cents=-h["bet"], kind="bet"
            )
        )
        user.balance_cents -= h["bet"]
        h["bet"] *= 2
        h["doubled"] = True
        h["cards"].append(draw("player"))
        h["done"] = True
        for idx in range(active + 1, len(hands)):
            if not hands[idx]["done"]:
                active = idx
                break
    elif action == "stand":
        hands[active]["done"] = True
        for idx in range(active + 1, len(hands)):
            if not hands[idx]["done"]:
                active = idx
                break
    elif action == "surrender":
        # Not exposed in UI currently; keep behavior for compatibility
        h = hands[active]
        if len(h["cards"]) != 2:
            raise HTTPException(400, "Surrender only on first move")
        refund = int(h["bet"]) // 2
        db.add(
            Transaction(
                user_id=user.id, session_id=s.id, amount_cents=refund, kind="refund"
            )
        )
        user.balance_cents += refund
        h["done"] = True
        for idx in range(active + 1, len(hands)):
            if not hands[idx]["done"]:
                active = idx
                break
        # If all hands surrendered/done, settle as zero payout (already refunded per-hand)
    elif action == "split":
        h = hands[active]
        cards = h["cards"]
        if len(cards) != 2:
            raise HTTPException(400, "Split only on first move")
        r0, r1 = cards[0]["r"], cards[1]["r"]
        def rank_value(r: str) -> int:
            if r == "A":
                return 11
            if r in ("K","Q","J","10"):
                return 10
            return int(r)
        # Allow split if same rank OR both are 10-valued cards
        if not (r0 == r1 or (rank_value(r0) == 10 and rank_value(r1) == 10)):
            raise HTTPException(400, "Can only split same ranks or any two 10-value cards")
        if user.balance_cents < h["bet"]:
            raise HTTPException(400, "Insufficient balance to split")
        db.add(
            Transaction(
                user_id=user.id, session_id=s.id, amount_cents=-h["bet"], kind="bet"
            )
        )
        user.balance_cents -= h["bet"]
        c0, c1 = cards[0], cards[1]
        h0 = {"cards": [c0], "bet": h["bet"], "done": False, "doubled": False}
        h1 = {"cards": [c1], "bet": h["bet"], "done": False, "doubled": False}
        # draw one card to each new hand
        h0["cards"].append(draw("player"))
        h1["cards"].append(draw("player"))
        # mark naturals as done so player can't act on them
        def is_blackjack_cards(cards_list):
            if len(cards_list) != 2:
                return False
            ranks = [c["r"] for c in cards_list]
            return ("A" in ranks) and any(r in ("10", "J", "Q", "K") for r in ranks)
        if is_blackjack_cards(h0["cards"]):
            h0["done"] = True
        if is_blackjack_cards(h1["cards"]):
            h1["done"] = True
        # replace current hand with two hands
        hands = hands[:active] + [h0, h1] + hands[active + 1 :]
        # advance active to the first not-done hand from the split onward
        new_active = active
        for idx in range(active, len(hands)):
            if not hands[idx]["done"]:
                new_active = idx
                break
        active = new_active
    else:
        raise HTTPException(400, "Unknown action")

    # Persist state and maybe settle if all hands done
    total_bet = sum(int(h.get("bet", 0)) for h in hands)
    s.bet_cents = total_bet
    shoe_remaining = len(SHOES.get(user.id, {}).get("cards", []))
    s.state = {"dealer_hand": {"cards": d}, "hands": hands, "active": active, "shoe_remaining": shoe_remaining, "shoe_reshuffled": bool(state.get("shoe_reshuffled", False))}
    s.actions_log = (s.actions_log or []) + [action]

    # If all player hands finished, dealer plays then settle per hand
    if all(h["done"] for h in hands):
        while True:
            dv, dsoft = hand_value(d)
            if dv < 17 or (dv == 17 and dsoft):
                d.append(draw("dealer"))
            else:
                break
        shoe_remaining = len(SHOES.get(user.id, {}).get("cards", []))
        s.state = {"dealer_hand": {"cards": d}, "hands": hands, "active": active, "shoe_remaining": shoe_remaining, "shoe_reshuffled": bool(state.get("shoe_reshuffled", False))}
        dv, _ = hand_value(d)
        payouts = 0
        results = []
        # helper to detect naturals
        def is_blackjack_cards(cards_list):
            if len(cards_list) != 2:
                return False
            ranks = [c["r"] for c in cards_list]
            return ("A" in ranks) and any(r in ("10", "J", "Q", "K") for r in ranks)
        dealer_natural = is_blackjack_cards(d)
        for h in hands:
            hv, _ = hand_value(h["cards"])
            player_natural = is_blackjack_cards(h["cards"])  # allow natural per-hand after split
            if hv > 21:
                results.append(Outcome.lose.value)
                continue
            if player_natural:
                if dealer_natural:
                    # push
                    credit = int(h["bet"])
                    db.add(Transaction(user_id=user.id, session_id=s.id, amount_cents=credit, kind="refund"))
                    user.balance_cents += credit
                    payouts += credit
                    results.append(Outcome.push.value)
                else:
                    # blackjack payout 3:2
                    credit = int(h["bet"] * 2.5)
                    db.add(Transaction(user_id=user.id, session_id=s.id, amount_cents=credit, kind="payout"))
                    user.balance_cents += credit
                    payouts += credit
                    results.append(Outcome.blackjack.value)
                continue
            if dv > 21 or hv > dv:
                credit = int(h["bet"]) * 2
                db.add(Transaction(user_id=user.id, session_id=s.id, amount_cents=credit, kind="payout"))
                user.balance_cents += credit
                payouts += credit
                results.append(Outcome.win.value)
            elif hv < dv:
                results.append(Outcome.lose.value)
            else:
                credit = int(h["bet"])
                db.add(Transaction(user_id=user.id, session_id=s.id, amount_cents=credit, kind="refund"))
                user.balance_cents += credit
                payouts += credit
                results.append(Outcome.push.value)
        s.payout_cents = payouts
        s.status = "settled"
        s.ended_at = dt.datetime.utcnow()
        s.outcome = (
            results[0] if results and all(r == results[0] for r in results) else "mixed"
        )

    db.commit()
    db.refresh(s)
    return to_out(user, s)
