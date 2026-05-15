"""Database models for tonight-play-time"""
from sqlalchemy import create_engine, Column, Integer, String, Float, DateTime, Boolean, ForeignKey
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship
from datetime import datetime

DATABASE_URL = "sqlite:///./tonight_play_time.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    nickname = Column(String(100), nullable=False)
    password_hash = Column(String(255), nullable=False)
    pin_code = Column(String(4), default="1234")
    created_at = Column(DateTime, default=datetime.utcnow)
    
    sessions = relationship("HomeworkSession", back_populates="user")


class HomeworkSession(Base):
    __tablename__ = "homework_sessions"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    
    # Session data
    date = Column(String(10), nullable=False)  # YYYY-MM-DD
    homework_minutes = Column(Float, default=0)  # Actual homework time in minutes
    total_minutes = Column(Float, default=0)  # Total session time in minutes
    start_time = Column(DateTime, nullable=True)
    end_time = Column(DateTime, nullable=True)
    
    # Completion status
    completed = Column(Boolean, default=False)
    homework_done = Column(Boolean, default=False)
    correction_done = Column(Boolean, default=False)
    attitude_good = Column(Boolean, default=False)
    
    # Playtime
    playtime_type = Column(String(50), nullable=True)  # watch/toy/story/game/free
    playtime_minutes = Column(Float, default=0)
    
    # Bedtime setting
    bedtime = Column(String(5), default="21:30")  # HH:MM
    
    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    user = relationship("User", back_populates="sessions")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    Base.metadata.create_all(bind=engine)
