import os, datetime as dt
from jose import jwt, JWTError
from fastapi import HTTPException, status, Request, Response, Depends
from passlib.hash import bcrypt
from sqlalchemy.orm import Session
from .db import SessionLocal
from .models import User

JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
JWT_ALG = "HS256"
COOKIE_NAME = "session"

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def hash_pw(pw: str) -> str:
    return bcrypt.hash(pw)

def verify_pw(pw: str, h: str) -> bool:
    return bcrypt.verify(pw, h)

def make_jwt(user_id: int) -> str:
    now = dt.datetime.utcnow()
    payload = {"sub": str(user_id), "iat": int(now.timestamp()), "exp": int((now + dt.timedelta(days=7)).timestamp())}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)

def set_session_cookie(resp: Response, token: str):
    resp.set_cookie(key=COOKIE_NAME, value=token, httponly=True, secure=True, samesite="lax", max_age=7*24*3600, path="/")

def clear_session_cookie(resp: Response):
    resp.delete_cookie(COOKIE_NAME, path="/")

def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        data = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
        uid = int(data["sub"])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = db.query(User).get(uid)
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="Inactive or missing user")
    return user
