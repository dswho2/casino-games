import os
from pathlib import Path
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from .db import Base, engine
from .auth import router as auth_router
from .wallet import router as wallet_router
from .security import current_user
from .models import User  # ensure models import for table creation
from .games.blackjack import router as blackjack_router
from .games.roulette import router as roulette_router
from .games.poker import router as poker_router

def _load_env_from_file():
    # Load api/.env into process env for local/dev. In production (e.g. Vercel),
    # real environment variables take precedence and are already set.
    try:
        env_path = Path(__file__).with_name('.env')
        if env_path.exists():
            for raw in env_path.read_text(encoding='utf-8').splitlines():
                line = raw.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                key = k.strip()
                val = v.strip().strip('"').strip("'")
                # Do not override existing real envs
                os.environ.setdefault(key, val)
    except Exception:
        # Fail silent: absence or parse error of .env should not crash the app
        pass

_load_env_from_file()

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
app.include_router(poker_router)
