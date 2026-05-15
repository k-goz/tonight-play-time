"""Main FastAPI application for tonight-play-time"""
from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from sqlalchemy import func
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, date
import os

from database import get_db, init_db, User, HomeworkSession
from auth import (
    get_password_hash, verify_password, create_access_token, get_current_user
)

app = FastAPI(title="今晚还能玩多久 API", version="1.0.0")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize database on startup
@app.on_event("startup")
def startup_event():
    init_db()


# ==================== Pydantic Models ====================

class UserRegister(BaseModel):
    username: str
    nickname: str
    password: str

class UserLogin(BaseModel):
    username: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: int
    nickname: str

class SessionCreate(BaseModel):
    date: str
    bedtime: str = "21:30"

class SessionUpdate(BaseModel):
    homework_minutes: Optional[float] = None
    total_minutes: Optional[float] = None
    completed: Optional[bool] = None
    homework_done: Optional[bool] = None
    correction_done: Optional[bool] = None
    attitude_good: Optional[bool] = None
    playtime_type: Optional[str] = None
    playtime_minutes: Optional[float] = None
    bedtime: Optional[str] = None

class SessionResponse(BaseModel):
    id: int
    date: str
    homework_minutes: float
    total_minutes: float
    completed: bool
    homework_done: bool
    correction_done: bool
    attitude_good: bool
    playtime_type: Optional[str]
    playtime_minutes: float
    bedtime: str
    created_at: datetime
    updated_at: datetime

class StatsResponse(BaseModel):
    total_sessions: int
    total_homework_minutes: float
    avg_homework_minutes: float
    total_playtime_minutes: float
    completion_rate: float
    star_days: int  # Days with completed homework


# ==================== Auth Routes ====================

@app.post("/api/auth/register", response_model=TokenResponse)
def register(user: UserRegister, db: Session = Depends(get_db)):
    """Register a new user"""
    # Check if username exists
    existing_user = db.query(User).filter(User.username == user.username).first()
    if existing_user:
        raise HTTPException(status_code=400, detail="用户名已存在")
    
    # Create new user
    db_user = User(
        username=user.username,
        nickname=user.nickname,
        password_hash=get_password_hash(user.password)
    )
    db.add(db_user)
    db.commit()
    db.refresh(db_user)
    
    # Generate token
    access_token = create_access_token(data={"sub": db_user.id})
    return TokenResponse(
        access_token=access_token,
        user_id=db_user.id,
        nickname=db_user.nickname
    )


@app.post("/api/auth/login", response_model=TokenResponse)
def login(user: UserLogin, db: Session = Depends(get_db)):
    """Login with username and password"""
    db_user = db.query(User).filter(User.username == user.username).first()
    if not db_user or not verify_password(user.password, db_user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    
    access_token = create_access_token(data={"sub": db_user.id})
    return TokenResponse(
        access_token=access_token,
        user_id=db_user.id,
        nickname=db_user.nickname
    )


@app.get("/api/auth/me")
def get_me(current_user: User = Depends(get_current_user)):
    """Get current user info"""
    return {
        "user_id": current_user.id,
        "username": current_user.username,
        "nickname": current_user.nickname
    }


# ==================== Session Routes ====================

@app.post("/api/sessions", response_model=SessionResponse)
def create_session(
    session: SessionCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Create a new homework session for today"""
    # Check if session already exists for this date
    existing = db.query(HomeworkSession).filter(
        HomeworkSession.user_id == current_user.id,
        HomeworkSession.date == session.date
    ).first()
    
    if existing:
        raise HTTPException(status_code=400, detail="今天已有记录")
    
    db_session = HomeworkSession(
        user_id=current_user.id,
        date=session.date,
        bedtime=session.bedtime
    )
    db.add(db_session)
    db.commit()
    db.refresh(db_session)
    return db_session


@app.get("/api/sessions", response_model=List[SessionResponse])
def get_sessions(
    limit: int = 30,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get user's recent sessions"""
    sessions = db.query(HomeworkSession).filter(
        HomeworkSession.user_id == current_user.id
    ).order_by(HomeworkSession.date.desc()).limit(limit).all()
    return sessions


@app.get("/api/sessions/{session_id}", response_model=SessionResponse)
def get_session(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get a specific session"""
    session = db.query(HomeworkSession).filter(
        HomeworkSession.id == session_id,
        HomeworkSession.user_id == current_user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="记录不存在")
    return session


@app.put("/api/sessions/{session_id}", response_model=SessionResponse)
def update_session(
    session_id: int,
    update: SessionUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Update a homework session"""
    session = db.query(HomeworkSession).filter(
        HomeworkSession.id == session_id,
        HomeworkSession.user_id == current_user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="记录不存在")
    
    update_data = update.dict(exclude_unset=True)
    for key, value in update_data.items():
        setattr(session, key, value)
    
    db.commit()
    db.refresh(session)
    return session


@app.delete("/api/sessions/{session_id}")
def delete_session(
    session_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Delete a homework session"""
    session = db.query(HomeworkSession).filter(
        HomeworkSession.id == session_id,
        HomeworkSession.user_id == current_user.id
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="记录不存在")
    
    db.delete(session)
    db.commit()
    return {"message": "已删除"}


# ==================== Stats Routes ====================

@app.get("/api/stats", response_model=StatsResponse)
def get_stats(
    days: int = 30,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get user statistics for the last N days"""
    from datetime import timedelta
    cutoff_date = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%d")
    
    sessions = db.query(HomeworkSession).filter(
        HomeworkSession.user_id == current_user.id,
        HomeworkSession.date >= cutoff_date
    ).all()
    
    total_sessions = len(sessions)
    total_homework = sum(s.homework_minutes for s in sessions)
    total_playtime = sum(s.playtime_minutes for s in sessions)
    completed_count = sum(1 for s in sessions if s.completed)
    star_days = sum(1 for s in sessions if s.completed and s.homework_done and s.correction_done and s.attitude_good)
    
    return StatsResponse(
        total_sessions=total_sessions,
        total_homework_minutes=total_homework,
        avg_homework_minutes=total_homework / total_sessions if total_sessions > 0 else 0,
        total_playtime_minutes=total_playtime,
        completion_rate=completed_count / total_sessions if total_sessions > 0 else 0,
        star_days=star_days
    )


@app.get("/api/stats/weekly")
def get_weekly_stats(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Get weekly homework summary (last 7 days)"""
    from datetime import timedelta
    
    stats = []
    today = datetime.utcnow().date()
    
    for i in range(6, -1, -1):
        d = today - timedelta(days=i)
        date_str = d.strftime("%Y-%m-%d")
        weekday = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][d.weekday()]
        
        session = db.query(HomeworkSession).filter(
            HomeworkSession.user_id == current_user.id,
            HomeworkSession.date == date_str
        ).first()
        
        stats.append({
            "date": date_str,
            "weekday": weekday,
            "has_record": session is not None,
            "homework_minutes": session.homework_minutes if session else 0,
            "completed": session.completed if session else False,
            "star": session.completed and session.homework_done and session.correction_done and session.attitude_good if session else False
        })
    
    return stats


# ==================== Health Check ====================

@app.get("/api/health")
def health_check():
    return {"status": "ok", "service": "tonight-play-time"}


# ==================== Serve Static Files ====================

# Mount static files (frontend)
static_dir = os.path.join(os.path.dirname(__file__), "..")
if os.path.exists(os.path.join(static_dir, "index.html")):
    app.mount("/static", StaticFiles(directory=static_dir), name="static")
    
    @app.get("/")
    async def serve_index():
        return FileResponse(os.path.join(static_dir, "index.html"))
