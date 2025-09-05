# api/auth.py
from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session
from sqlalchemy import or_
from .schemas import RegisterIn, LoginIn, UserOut
from .models import User
from .security import get_db, hash_pw, verify_pw, make_jwt, set_session_cookie, clear_session_cookie

router = APIRouter(prefix="/auth", tags=["auth"])

@router.post("/register", response_model=UserOut)
def register(payload: RegisterIn, response: Response, db: Session = Depends(get_db)):
    # username must be unique
    if db.query(User).filter(User.username == payload.username).first():
        raise HTTPException(400, "Username already exists")
    # email, if present, must be unique
    if payload.email and db.query(User).filter(User.email == payload.email).first():
        raise HTTPException(400, "Email already exists")

    user = User(
        email=payload.email,
        username=payload.username,
        password_hash=hash_pw(payload.password)
    )
    db.add(user); db.commit(); db.refresh(user)

    token = make_jwt(user.id)
    set_session_cookie(response, token)
    return UserOut(id=user.id, email=user.email, username=user.username, balance_cents=user.balance_cents)

@router.post("/login", response_model=UserOut)
def login(payload: LoginIn, response: Response, db: Session = Depends(get_db)):
    ident = payload.identifier.strip()
    # TODO: Consider case-insensitive email checks, e.g., func.lower(User.email) == ident.lower()
    user = db.query(User).filter(or_(User.username == ident, User.email == ident)).first()
    if not user or not verify_pw(payload.password, user.password_hash):
        raise HTTPException(401, "Invalid credentials")

    token = make_jwt(user.id)
    set_session_cookie(response, token)
    return UserOut(id=user.id, email=user.email, username=user.username, balance_cents=user.balance_cents)

@router.post("/logout")
def logout(response: Response):
    clear_session_cookie(response)
    return {"ok": True}
