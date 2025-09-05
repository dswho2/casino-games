import os
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from .db import Base, engine
from .auth import router as auth_router
from .wallet import router as wallet_router
from .security import current_user
from .models import User  # ensure models import for table creation
from .games.blackjack import router as blackjack_router
from .games.roulette import router as roulette_router

app = FastAPI(title="Casino API")

# TODO: For multi-origin deployments, consider a stricter allowlist or dynamic origin checks
origins = [os.getenv("CLIENT_ORIGIN", "http://localhost:5173")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

Base.metadata.create_all(bind=engine)

@app.get("/healthz")
def healthz(): return {"ok": True}

@app.get("/me")
def me(user=Depends(current_user)):
    return {"id": user.id, "email": user.email, "username": user.username, "balance_cents": user.balance_cents}

app.include_router(auth_router)
app.include_router(wallet_router)
app.include_router(blackjack_router)
app.include_router(roulette_router)
