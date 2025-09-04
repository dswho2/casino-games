import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

DATABASE_URL = os.getenv("DATABASE_URL")

# Dev-friendly fallback: SQLite if no DATABASE_URL is set
if not DATABASE_URL:
    DATABASE_URL = "sqlite:///./dev.db"
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
else:
    # Neon requires SSL; Vercel integration provides it. Add if missing for local envs.
    if "sslmode" not in DATABASE_URL and DATABASE_URL.startswith("postgresql"):
        sep = "&" if "?" in DATABASE_URL else "?"
        DATABASE_URL = f"{DATABASE_URL}{sep}sslmode=require"
    engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_recycle=300)

class Base(DeclarativeBase):
    pass

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
