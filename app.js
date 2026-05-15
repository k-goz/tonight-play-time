/**
 * 今晚还能玩多久 - 核心应用逻辑
 *
 * 状态机：idle → running ⇄ paused → reviewing → completed
 * 数据持久化：localStorage
 * 时间标准：北京时间 (Asia/Shanghai)
 */

// =============================================
// 一、常量与配置
// =============================================

/** 应用状态枚举 */
const STATE = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  REVIEWING: 'reviewing',
  COMPLETED: 'completed'
};

/** localStorage 键名 */
const STORAGE_KEYS = {
  RECORDS: 'homework_timer_records',
  TODAY_STATE: 'homework_timer_today_state',
  SETTINGS: 'homework_timer_settings'
};

/** 鼓励文案库 */
const ENCOURAGEMENTS = [
  '今天的小任务开始啦！加油！',
  '你正在认真写作业，真棒！',
  '继续保持，快乐时间还在等你！',
  '每一分钟的努力，都在为你赢得快乐时间！',
  '认真写字的小朋友最厉害了！',
  '专注的你，像小火箭一样棒！',
  '休息一下也没关系，回来继续加油！',
  '你离快乐时间越来越近啦！',
  '今天的作业怪兽，一定打不过你！',
  '一点一点完成，就是很了不起！'
];

/** 完成后鼓励文案 */
const COMPLETION_MESSAGES = [
  '太棒啦！今天的任务完成！',
  '你认真完成了今天的小挑战！',
  '专注的小朋友，值得拥有快乐时间！',
  '今天也把作业怪兽打败啦！',
  '你为自己赢回了睡前快乐时间！',
  '一点一点进步，就是很厉害！',
  '今天的你，是时间小管家！',
  '认真完成作业的小朋友，最棒了！'
];

/** 称号库 */
const TITLES = [
  '专注小火箭',
  '作业小勇士',
  '时间小管家',
  '订正小侦探',
  '彩虹能量大师',
  '快乐时间守护者',
  '认真小明星'
];

/** 星期名称 */
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/** 计时刷新间隔（毫秒） */
const TICK_INTERVAL = 200;

// =============================================
// 二、时间工具函数
// =============================================

const TimeUtils = {
  /**
   * 获取当前北京时间 Date 对象
   */
  getBeijingNow() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  },

  /**
   * 格式化时间为 HH:MM:SS
   */
  formatTime(date) {
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'Asia/Shanghai'
    });
  },

  /**
   * 格式化日期为 YYYY年MM月DD日 星期X
   */
  formatDate(date) {
    const y = date.getFullYear();
    const m = date.getMonth() + 1;
    const d = date.getDate();
    const w = WEEKDAYS[date.getDay()];
    return `${y}年${m}月${d}日 星期${w}`;
  },

  /**
   * 获取北京时间日期字符串 YYYY-MM-DD
   */
  getBeijingDateStr(date) {
    const d = date || this.getBeijingNow();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },

  /**
   * 获取北京时间时间字符串 HH:MM:SS
   */
  getBeijingTimeStr(date) {
    const d = date || this.getBeijingNow();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
  },

  /**
   * 获取今天睡觉时间的 Date 对象（北京时间）
   */
  getBedtimeDate(bedtimeStr) {
    const now = this.getBeijingNow();
    const [h, m] = bedtimeStr.split(':').map(Number);
    const bedtime = new Date(now);
    bedtime.setHours(h, m, 0, 0);
    return bedtime;
  },

  /**
   * 计算距离睡觉时间的剩余秒数
   */
  getSecondsToBedtime(bedtimeStr) {
    const now = this.getBeijingNow();
    const bedtime = this.getBedtimeDate(bedtimeStr);
    const diff = bedtime - now;
    return Math.max(0, Math.floor(diff / 1000));
  },

  /**
   * 将秒数格式化为可读文本
   */
  formatDuration(totalSeconds) {
    if (totalSeconds <= 0) return '0 分钟';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
    }
    if (minutes > 0) {
      return seconds > 0 ? `${minutes} 分钟 ${seconds} 秒` : `${minutes} 分钟`;
    }
    return `${seconds} 秒`;
  },

  /**
   * 将秒数格式化为短文本（用于显示）
   */
  formatDurationShort(totalSeconds) {
    if (totalSeconds <= 0) return '0分钟';
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours > 0 && minutes > 0) return `${hours}h${minutes}m`;
    if (hours > 0) return `${hours}h`;
    return `${minutes}分钟`;
  }
};

// =============================================
// 音效工具
// =============================================

const SoundUtils = {
  ctx: null,
  init() {
    if (!this.ctx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.ctx = new AudioContext();
      }
    }
  },
  playTone(freq, type, duration, vol) {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      gain.gain.setValueAtTime(vol, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch (e) {
      console.warn('Audio play failed', e);
    }
  },
  playClick() {
    this.playTone(600, 'sine', 0.1, 0.1);
  },
  playStart() {
    this.playTone(660, 'sine', 0.1, 0.3);
    setTimeout(() => this.playTone(880, 'sine', 0.2, 0.3), 100);
  },
  playFinish() {
    this.playTone(523.25, 'triangle', 0.15, 0.3);
    setTimeout(() => this.playTone(659.25, 'triangle', 0.15, 0.3), 150);
    setTimeout(() => this.playTone(783.99, 'triangle', 0.15, 0.3), 300);
    setTimeout(() => this.playTone(1046.50, 'triangle', 0.4, 0.3), 450);
  },
  playPause() {
    this.playTone(300, 'square', 0.1, 0.1);
  }
};

// =============================================
// 三、存储工具
// =============================================

const Storage = {
  /**
   * 读取 JSON 数据
   */
  get(key, defaultValue) {
    try {
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : defaultValue;
    } catch (e) {
      console.warn('Storage read error:', e);
      return defaultValue;
    }
  },

  /**
   * 写入 JSON 数据
   */
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn('Storage write error:', e);
    }
  },

  /** 获取所有记录 */
  getRecords() {
    return this.get(STORAGE_KEYS.RECORDS, []);
  },

  /** 保存所有记录 */
  saveRecords(records) {
    this.set(STORAGE_KEYS.RECORDS, records);
  },

  /** 添加一条记录 */
  addRecord(record) {
    const records = this.getRecords();
    records.push(record);
    this.saveRecords(records);
  },

  /** 获取今日状态 */
  getTodayState() {
    return this.get(STORAGE_KEYS.TODAY_STATE, null);
  },

  /** 保存今日状态 */
  saveTodayState(state) {
    this.set(STORAGE_KEYS.TODAY_STATE, state);
  },

  /** 清除今日状态 */
  clearTodayState() {
    localStorage.removeItem(STORAGE_KEYS.TODAY_STATE);
  },

  /** 获取设置 */
  getSettings() {
    return this.get(STORAGE_KEYS.SETTINGS, {
      bedtime: '21:30',
      parentPin: '1234'
    });
  },

  /** 保存设置 */
  saveSettings(settings) {
    this.set(STORAGE_KEYS.SETTINGS, settings);
  }
};

// =============================================
// 四、应用主逻辑
// =============================================

const App = {
  /** 当前状态 */
  state: STATE.IDLE,

  /** 计时器 interval ID */
  timerInterval: null,

  /** 作业开始时间（北京时间 ISO 字符串） */
  startTime: null,

  /** 作业累计用时（秒），不含暂停 */
  homeworkSeconds: 0,

  /** 暂停开始时间戳 */
  pauseStart: null,

  /** 暂停累计时间（秒） */
  pausedSeconds: 0,

  /** 上次 tick 时间戳（用于精确计时） */
  lastTick: null,

  /** 冻结的剩余时间（进入审核状态时的秒数） */
  frozenRemainingSeconds: null,

  /** 设置 */
  settings: null,

  /** 当前显示的鼓励文案索引 */
  encouragementIndex: 0,

  /** 鼓励文案切换定时器 */
  encouragementTimer: null,

  // ---------- 初始化 ----------

  init() {
    // Initialize API service
    this.apiReady = false;
    this.currentSessionId = null;

    // Check if user is logged in
    if (API_SERVICE.isLoggedIn()) {
      this.apiReady = true;
      this.user = API_SERVICE.user;
      console.log('User logged in:', this.user.nickname);
    }

    this.settings = Storage.getSettings();
    this.updateBedtimeDisplay();
    this.bindEvents();
    this.bindAuthEvents();
    this.restoreTodayState();
    this.startClock();
    this.registerSW();
  },

  updateBedtimeDisplay() {
    const [h, m] = this.settings.bedtime.split(':');
    document.querySelector('.bedtime-info').textContent = `💤 睡觉时间：晚上 ${h}:${m}`;
  },

  // ---------- 事件绑定 ----------

  bindEvents() {
    // 主按钮
    document.getElementById('btn-start').addEventListener('click', () => this.startHomework());
    document.getElementById('btn-pause').addEventListener('click', () => this.pauseHomework());
    document.getElementById('btn-resume').addEventListener('click', () => this.resumeHomework());
    document.getElementById('btn-finish').addEventListener('click', () => this.finishHomework());

    // 重新开始
    document.getElementById('btn-reset').addEventListener('click', () => this.resetToday());

    // 家长确认
    document.getElementById('btn-confirm').addEventListener('click', () => this.confirmComplete());
    document.getElementById('btn-call-it-a-day').addEventListener('click', () => this.callItADay());
    document.getElementById('btn-retry').addEventListener('click', () => this.retryHomework());

    // 确认清单联动
    const checkboxes = ['check-homework', 'check-corrections', 'check-attitude'];
    checkboxes.forEach(id => {
      document.getElementById(id).addEventListener('change', () => this.updateConfirmButton());
    });

    // 快乐时间选择
    document.querySelectorAll('.reward-btn').forEach(btn => {
      btn.addEventListener('click', () => this.selectReward(btn));
    });

    // 返回首页
    document.getElementById('btn-back-home').addEventListener('click', () => this.goHome());

    // 家长数据页面
    document.getElementById('btn-stats').addEventListener('click', () => this.showStatsPage());
    document.getElementById('btn-back').addEventListener('click', () => this.hideStatsPage());
    document.getElementById('btn-pin').addEventListener('click', () => this.verifyPin());
    document.getElementById('pin-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.verifyPin();
    });

    // 数据页签切换
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn));
    });

    // 设置保存
    document.getElementById('btn-save-settings').addEventListener('click', () => this.saveSettings());
    document.getElementById('btn-export').addEventListener('click', () => this.exportData());
    const btnClearData = document.getElementById('btn-clear-data');
    if (btnClearData) {
      btnClearData.addEventListener('click', () => this.clearAllData());
    }

    // Logout button (add to settings section)
    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'btn btn-danger';
    logoutBtn.textContent = '🚪 退出登录';
    logoutBtn.style.marginTop = '0.5rem';
    logoutBtn.addEventListener('click', () => this.handleLogout());
    const settingsSection = document.querySelector('.settings-section .setting-actions');
    if (settingsSection) {
      settingsSection.appendChild(logoutBtn);
    }
  },

  // ---------- 认证事件 ----------

  bindAuthEvents() {
    // 登录表单切换
    document.getElementById('show-register').addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('login-form').style.display = 'none';
      document.getElementById('register-form').style.display = 'block';
    });

    document.getElementById('show-login').addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('register-form').style.display = 'none';
      document.getElementById('login-form').style.display = 'block';
    });

    // 登录按钮
    document.getElementById('btn-login').addEventListener('click', () => this.handleLogin());
    document.getElementById('login-password').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleLogin();
    });

    // 注册按钮
    document.getElementById('btn-register').addEventListener('click', () => this.handleRegister());
    document.getElementById('reg-password').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleRegister();
    });

    // 跳过登录
    document.getElementById('skip-login').addEventListener('click', (e) => {
      e.preventDefault();
      this.skipAuth();
    });

    // 检查是否需要显示登录页
    this.checkAuthState();
  },

  checkAuthState() {
    if (API_SERVICE.isLoggedIn()) {
      this.enterApp();
    } else if (localStorage.getItem('skip_auth') === 'true') {
      this.enterApp();
    }
  },

  async handleLogin() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errorEl = document.getElementById('login-error');

    if (!username || !password) {
      errorEl.textContent = '请输入用户名和密码';
      errorEl.style.display = 'block';
      return;
    }

    try {
      await API_SERVICE.login(username, password);
      this.user = API_SERVICE.user;
      this.apiReady = true;
      this.enterApp();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.style.display = 'block';
    }
  },

  async handleRegister() {
    const username = document.getElementById('reg-username').value.trim();
    const nickname = document.getElementById('reg-nickname').value.trim();
    const password = document.getElementById('reg-password').value;
    const errorEl = document.getElementById('register-error');

    if (!username || !nickname || !password) {
      errorEl.textContent = '请填写所有字段';
      errorEl.style.display = 'block';
      return;
    }

    if (password.length < 4) {
      errorEl.textContent = '密码至少4位';
      errorEl.style.display = 'block';
      return;
    }

    try {
      await API_SERVICE.register(username, nickname, password);
      this.user = API_SERVICE.user;
      this.apiReady = true;
      this.enterApp();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.style.display = 'block';
    }
  },

  skipAuth() {
    localStorage.setItem('skip_auth', 'true');
    this.apiReady = false;
    this.enterApp();
  },

  enterApp() {
    document.getElementById('page-auth').classList.remove('active');
    document.getElementById('page-auth').style.display = 'none';
    document.getElementById('page-timer').classList.add('active');
    document.getElementById('page-timer').style.display = 'block';

    if (this.user) {
      this.addUserInfoToHeader();
    }

    if (this.apiReady) {
      this.syncFromServer();
    }
  },

  addUserInfoToHeader() {
    const headerRight = document.querySelector('.header-right');
    const existingInfo = document.querySelector('.user-info');
    if (existingInfo) return;

    const userInfo = document.createElement('div');
    userInfo.className = 'user-info';
    userInfo.innerHTML = `
      <span class="user-avatar">${this.user.nickname.charAt(0)}</span>
      <span>${this.user.nickname}</span>
    `;
    headerRight.insertBefore(userInfo, headerRight.firstChild);
  },

  async syncFromServer() {
    if (!this.apiReady) return;

    try {
      const today = TimeUtils.getBeijingDateStr();
      const sessions = await API_SERVICE.getSessions(1);
      const todaySession = sessions.find(s => s.date === today);

      if (todaySession) {
        this.currentSessionId = todaySession.id;
        this.restoreFromServerSession(todaySession);
      }

      console.log('Data synced from server');
    } catch (error) {
      console.warn('Failed to sync from server:', error);
    }
  },

  restoreFromServerSession(session) {
    if (session.completed) {
      this.state = STATE.COMPLETED;
      this.homeworkSeconds = session.homework_minutes * 60;
      this.showCompletionPage(session);
    }
  },

  async handleLogout() {
    if (confirm('确定要退出登录吗？')) {
      API_SERVICE.logout();
      this.user = null;
      this.apiReady = false;
      localStorage.removeItem('skip_auth');
      location.reload();
    }
  },

  // ---------- 时钟更新 ----------

  startClock() {
    const updateClock = () => {
      const now = TimeUtils.getBeijingNow();
      document.getElementById('current-time').textContent = TimeUtils.formatTime(now);
      document.getElementById('date-display').textContent = TimeUtils.formatDate(now);

      // 更新剩余快乐时间（实时计算）
      if (this.state === STATE.RUNNING || this.state === STATE.PAUSED) {
        this.updateTimerDisplay();
      }
    };

    updateClock();
    setInterval(updateClock, 1000);
  },

  // ---------- 作业计时 ----------

  startHomework() {
    SoundUtils.playStart();
    const now = TimeUtils.getBeijingNow();
    this.state = STATE.RUNNING;
    this.startTime = now.toISOString();
    this.homeworkSeconds = 0;
    this.pausedSeconds = 0;
    this.pauseStart = null;
    this.frozenRemainingSeconds = null;
    this.lastTick = Date.now();

    this.saveTodayState();
    this.updateUI();
    this.startTimer();
    this.startEncouragementRotation();
  },

  pauseHomework() {
    SoundUtils.playPause();
    this.state = STATE.PAUSED;
    this.pauseStart = Date.now();
    this.stopTimer();
    this.saveTodayState();
    this.updateUI();
    this.showPausedOverlay();
  },

  resumeHomework() {
    SoundUtils.playClick();
    // 累加暂停时间
    if (this.pauseStart) {
      this.pausedSeconds += Math.floor((Date.now() - this.pauseStart) / 1000);
      this.pauseStart = null;
    }

    this.state = STATE.RUNNING;
    this.lastTick = Date.now();
    this.saveTodayState();
    this.updateUI();
    this.startTimer();
    this.startEncouragementRotation();
  },

  finishHomework() {
    SoundUtils.playFinish();
    this.state = STATE.REVIEWING;
    this.stopTimer();
    this.stopEncouragementRotation();
    this.frozenRemainingSeconds = TimeUtils.getSecondsToBedtime(this.settings.bedtime);
    this.saveTodayState();
    this.updateUI();
    this.showParentConfirm();
  },

  retryHomework() {
    SoundUtils.playClick();
    // 回到计时状态
    this.hideParentConfirm();
    this.state = STATE.RUNNING;
    this.frozenRemainingSeconds = null;
    this.lastTick = Date.now();
    this.saveTodayState();
    this.updateUI();
    this.startTimer();
    this.startEncouragementRotation();

    // 显示提示
    this.showTemporaryTip('🕵️ 小侦探发现还有一点点需要修正，加油，马上就能解锁快乐时间！');
  },

  confirmComplete() {
    const now = TimeUtils.getBeijingNow();
    const bedtimeStr = this.settings.bedtime;
    const remainingSeconds = this.frozenRemainingSeconds !== null 
      ? this.frozenRemainingSeconds 
      : TimeUtils.getSecondsToBedtime(bedtimeStr);

    // 构建记录
    const record = {
      date: TimeUtils.getBeijingDateStr(now),
      startTime: TimeUtils.getBeijingTimeStr(new Date(this.startTime)),
      finishTime: TimeUtils.getBeijingTimeStr(now),
      homeworkDurationSeconds: this.homeworkSeconds,
      pausedDurationSeconds: this.pausedSeconds,
      remainingSeconds: remainingSeconds,
      rewardChoice: '',
      title: TITLES[Math.floor(Math.random() * TITLES.length)],
      checklist: {
        homeworkDone: document.getElementById('check-homework').checked,
        correctionsDone: document.getElementById('check-corrections').checked,
        attitudeGood: document.getElementById('check-attitude').checked
      }
    };

    // 保存记录
    Storage.addRecord(record);
    Storage.clearTodayState();

    this.state = STATE.COMPLETED;
    this.stopTimer();
    this.stopEncouragementRotation();
    this.hideParentConfirm();
    this.showCelebration(record);
  },

  callItADay() {
    SoundUtils.playClick();
    const now = TimeUtils.getBeijingNow();
    const bedtimeStr = this.settings.bedtime;
    const remainingSeconds = this.frozenRemainingSeconds !== null
      ? this.frozenRemainingSeconds
      : TimeUtils.getSecondsToBedtime(bedtimeStr);

    // 构建记录，标记为"今天就到这吧"
    const record = {
      date: TimeUtils.getBeijingDateStr(now),
      startTime: TimeUtils.getBeijingTimeStr(new Date(this.startTime)),
      finishTime: TimeUtils.getBeijingTimeStr(now),
      homeworkDurationSeconds: this.homeworkSeconds,
      pausedDurationSeconds: this.pausedSeconds,
      remainingSeconds: remainingSeconds,
      rewardChoice: '',
      title: '',
      callItADay: true,
      checklist: {
        homeworkDone: document.getElementById('check-homework').checked,
        correctionsDone: document.getElementById('check-corrections').checked,
        attitudeGood: document.getElementById('check-attitude').checked
      }
    };

    // 保存记录
    Storage.addRecord(record);
    Storage.clearTodayState();

    this.state = STATE.COMPLETED;
    this.stopTimer();
    this.stopEncouragementRotation();
    this.hideParentConfirm();
    this.showCallItADayPage(record);
  },

  resetToday() {
    if (!confirm('确定要重新开始今天吗？当前的作业计时会被清除。')) return;

    this.state = STATE.IDLE;
    this.stopTimer();
    this.stopEncouragementRotation();
    Storage.clearTodayState();
    this.homeworkSeconds = 0;
    this.pausedSeconds = 0;
    this.startTime = null;
    this.updateUI();
  },

  // ---------- 计时器核心 ----------

  startTimer() {
    this.stopTimer();
    this.lastTick = Date.now();
    this.timerInterval = setInterval(() => this.tick(), TICK_INTERVAL);
  },

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  },

  tick() {
    if (this.state !== STATE.RUNNING) return;

    const now = Date.now();
    const delta = (now - this.lastTick) / 1000;
    this.lastTick = now;

    // 累加作业时间
    this.homeworkSeconds += delta;

    // 更新显示
    this.updateTimerDisplay();

    // 每 30 秒保存一次状态
    if (Math.floor(this.homeworkSeconds) % 30 === 0) {
      this.saveTodayState();
    }
  },

  updateTimerDisplay() {
    const homeworkSec = Math.floor(this.homeworkSeconds);
    const remainingSec = TimeUtils.getSecondsToBedtime(this.settings.bedtime);

    // 更新卡片
    document.getElementById('homework-time').textContent = TimeUtils.formatDuration(homeworkSec);
    document.getElementById('happy-time').textContent = TimeUtils.formatDuration(remainingSec);

    // 更新进度条
    this.updateProgressBar(homeworkSec, remainingSec);

    // 如果剩余时间为 0，更新提示
    if (remainingSec <= 0) {
      document.getElementById('happy-label').textContent = '已经到睡觉时间';
      document.getElementById('happy-sublabel').textContent = '该休息啦';
      document.getElementById('happy-emoji').textContent = '😴';
    }
  },

  updateProgressBar(homeworkSec, remainingSec) {
    const total = homeworkSec + remainingSec;
    if (total <= 0) return;

    const homeworkPercent = (homeworkSec / total) * 100;
    const happyPercent = (remainingSec / total) * 100;

    document.getElementById('progress-homework').style.width = homeworkPercent + '%';
    document.getElementById('progress-happy').style.width = happyPercent + '%';
    document.getElementById('progress-rocket').style.left = homeworkPercent + '%';
  },

  // ---------- UI 更新 ----------

  updateUI() {
    // 按钮显示逻辑
    const btnStart = document.getElementById('btn-start');
    const btnPause = document.getElementById('btn-pause');
    const btnResume = document.getElementById('btn-resume');
    const btnFinish = document.getElementById('btn-finish');
    const btnReset = document.getElementById('btn-reset');

    // 先隐藏所有按钮
    btnStart.style.display = 'none';
    btnPause.style.display = 'none';
    btnResume.style.display = 'none';
    btnFinish.style.display = 'none';
    btnReset.style.display = 'none';

    switch (this.state) {
      case STATE.IDLE:
        btnStart.style.display = '';
        this.setEncouragement('点击下方按钮，开始今天的小任务吧！');
        this.resetProgressDisplay();
        break;

      case STATE.RUNNING:
        btnPause.style.display = '';
        btnFinish.style.display = '';
        btnReset.style.display = '';
        break;

      case STATE.PAUSED:
        btnResume.style.display = '';
        btnFinish.style.display = '';
        btnReset.style.display = '';
        break;

      case STATE.REVIEWING:
        btnReset.style.display = '';
        break;

      case STATE.COMPLETED:
        // 庆祝页面处理
        break;
    }
  },

  resetProgressDisplay() {
    document.getElementById('homework-time').textContent = '0 分钟';
    document.getElementById('happy-time').textContent = TimeUtils.formatDuration(
      TimeUtils.getSecondsToBedtime(this.settings.bedtime)
    );
    document.getElementById('happy-label').textContent = '还可以拥有';
    document.getElementById('happy-sublabel').textContent = '快乐时间';
    document.getElementById('happy-emoji').textContent = '🌈';
    document.getElementById('progress-homework').style.width = '0%';
    document.getElementById('progress-rocket').style.left = '0%';
  },

  // ---------- 鼓励文案 ----------

  setEncouragement(text) {
    document.getElementById('encouragement').textContent = text;
  },

  startEncouragementRotation() {
    this.stopEncouragementRotation();
    this.encouragementTimer = setInterval(() => {
      this.encouragementIndex = (this.encouragementIndex + 1) % ENCOURAGEMENTS.length;
      this.setEncouragement(ENCOURAGEMENTS[this.encouragementIndex]);
    }, 8000);
  },

  stopEncouragementRotation() {
    if (this.encouragementTimer) {
      clearInterval(this.encouragementTimer);
      this.encouragementTimer = null;
    }
  },

  showTemporaryTip(text) {
    const el = document.getElementById('encouragement');
    el.textContent = text;
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 500);
  },

  // ---------- 暂停覆盖层 ----------

  showPausedOverlay() {
    // 移除已有的暂停覆盖层
    this.hidePausedOverlay();

    const overlay = document.createElement('div');
    overlay.className = 'paused-overlay';
    overlay.id = 'paused-overlay';
    overlay.innerHTML = `
      <div class="paused-card">
        <div class="paused-icon">☕</div>
        <h2>休息一下</h2>
        <p>休息一下，马上回来继续吧！</p>
        <button class="btn btn-primary btn-large" onclick="App.resumeFromOverlay()">
          ▶️ 继续作业
        </button>
      </div>
    `;
    document.body.appendChild(overlay);
  },

  hidePausedOverlay() {
    const existing = document.getElementById('paused-overlay');
    if (existing) existing.remove();
  },

  resumeFromOverlay() {
    this.hidePausedOverlay();
    this.resumeHomework();
  },

  // ---------- 家长确认弹窗 ----------

  showParentConfirm() {
    // 重置勾选状态
    document.getElementById('check-homework').checked = false;
    document.getElementById('check-corrections').checked = false;
    document.getElementById('check-attitude').checked = false;
    document.getElementById('btn-confirm').disabled = true;
    document.getElementById('parent-tip').style.display = 'none';

    document.getElementById('modal-parent').style.display = '';
  },

  hideParentConfirm() {
    document.getElementById('modal-parent').style.display = 'none';
  },

  updateConfirmButton() {
    const allChecked =
      document.getElementById('check-homework').checked &&
      document.getElementById('check-corrections').checked &&
      document.getElementById('check-attitude').checked;
    document.getElementById('btn-confirm').disabled = !allChecked;
  },

  // ---------- 庆祝页面 ----------

  showCelebration(record) {
    // 隐藏计时页面
    document.getElementById('page-timer').classList.remove('active');
    document.getElementById('page-timer').style.display = 'none';

    // 显示庆祝页面
    const page = document.getElementById('page-celebration');
    page.style.display = '';
    page.classList.add('active');

    // 填充数据
    const happyMinutes = Math.floor(record.remainingSeconds / 60);
    document.getElementById('celebration-title').textContent =
      COMPLETION_MESSAGES[Math.floor(Math.random() * COMPLETION_MESSAGES.length)];
    document.getElementById('celebration-badge').textContent = record.title;
    document.getElementById('celebration-time').innerHTML = happyMinutes > 0
      ? `你为自己赢得了 <span class="highlight">${happyMinutes}</span> 分钟快乐时间！`
      : `今天完成得有点晚，快乐时间已经到了睡觉时间。<br>但完成作业的你依然很棒！`;
    document.getElementById('celebration-message').textContent =
      '认真完成作业的小朋友，值得拥有快乐时间！';

    // 重置快乐时间选择
    document.querySelectorAll('.reward-btn').forEach(btn => btn.classList.remove('selected'));

    // 启动撒花
    this.startConfetti();
  },

  showCallItADayPage(record) {
    // 隐藏计时页面
    document.getElementById('page-timer').classList.remove('active');
    document.getElementById('page-timer').style.display = 'none';

    // 显示庆祝页面（复用，但内容不同）
    const page = document.getElementById('page-celebration');
    page.style.display = '';
    page.classList.add('active');

    // 填充数据 - 温和的结束文案
    const checks = record.checklist || {};
    const checkCount = (checks.homeworkDone ? 1 : 0) + (checks.correctionsDone ? 1 : 0) + (checks.attitudeGood ? 1 : 0);
    const homeworkTime = TimeUtils.formatDuration(Math.floor(record.homeworkDurationSeconds));

    document.getElementById('celebration-title').textContent = '🌙 今天辛苦啦！';
    document.getElementById('celebration-badge').textContent = '今天到这了';
    document.getElementById('celebration-badge').style.background = 'linear-gradient(135deg, #6B7280, #9CA3AF)';

    let summaryHtml = `今天写了 <span class="highlight">${homeworkTime}</span> 作业`;
    if (checkCount > 0) {
      summaryHtml += `，完成了 ${checkCount} 项检查`;
    }
    summaryHtml += '。<br>好好休息，明天继续加油！';
    document.getElementById('celebration-time').innerHTML = summaryHtml;

    document.getElementById('celebration-message').textContent =
      checkCount === 0
        ? '没关系，明天把作业都完成就更棒了！'
        : '已经很不错了，明天继续努力！';

    // 隐藏快乐时间选择区域
    document.querySelector('.reward-section').style.display = 'none';

    // 启动撒花（少量，温馨风格）
    this.startConfetti();
  },

  goHome() {
    // 隐藏庆祝页面
    document.getElementById('page-celebration').classList.remove('active');
    document.getElementById('page-celebration').style.display = 'none';

    // 恢复快乐时间选择区域
    document.querySelector('.reward-section').style.display = '';
    // 恢复 badge 样式
    document.getElementById('celebration-badge').style.background = '';

    // 重置状态
    this.state = STATE.IDLE;
    this.homeworkSeconds = 0;
    this.pausedSeconds = 0;
    this.startTime = null;

    // 显示计时页面
    const page = document.getElementById('page-timer');
    page.style.display = '';
    page.classList.add('active');

    this.updateUI();
  },

  // ---------- 撒花动画 ----------

  startConfetti() {
    const container = document.getElementById('confetti-container');
    container.innerHTML = '';

    const colors = ['#FF6B6B', '#FFE66D', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE'];
    const shapes = ['square', 'circle'];

    for (let i = 0; i < 60; i++) {
      const confetti = document.createElement('div');
      confetti.className = 'confetti';
      const color = colors[Math.floor(Math.random() * colors.length)];
      const shape = shapes[Math.floor(Math.random() * shapes.length)];
      const size = 8 + Math.random() * 12;
      const left = Math.random() * 100;
      const delay = Math.random() * 2;
      const duration = 2 + Math.random() * 3;

      confetti.style.cssText = `
        left: ${left}%;
        width: ${size}px;
        height: ${size}px;
        background: ${color};
        border-radius: ${shape === 'circle' ? '50%' : '2px'};
        animation-delay: ${delay}s;
        animation-duration: ${duration}s;
      `;
      container.appendChild(confetti);
    }

    // 添加一些星星
    for (let i = 0; i < 15; i++) {
      const star = document.createElement('div');
      star.className = 'confetti';
      star.textContent = '⭐';
      star.style.cssText = `
        left: ${Math.random() * 100}%;
        font-size: ${12 + Math.random() * 16}px;
        animation-delay: ${Math.random() * 2}s;
        animation-duration: ${2 + Math.random() * 3}s;
        background: none;
        width: auto;
        height: auto;
      `;
      container.appendChild(star);
    }

    // 5 秒后清除
    setTimeout(() => {
      container.innerHTML = '';
    }, 6000);
  },

  // ---------- 快乐时间选择 ----------

  selectReward(btn) {
    // 移除其他选中状态
    document.querySelectorAll('.reward-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');

    // 保存到最新记录
    const records = Storage.getRecords();
    if (records.length > 0) {
      records[records.length - 1].rewardChoice = btn.dataset.choice;
      Storage.saveRecords(records);
    }
  },

  // ---------- 状态持久化 ----------

  saveTodayState() {
    if (this.state === STATE.IDLE || this.state === STATE.COMPLETED) return;

    const stateData = {
      date: TimeUtils.getBeijingDateStr(),
      state: this.state,
      startTime: this.startTime,
      homeworkSeconds: this.homeworkSeconds,
      pausedSeconds: this.pausedSeconds,
      pauseStart: this.pauseStart,
      frozenRemainingSeconds: this.frozenRemainingSeconds
    };

    Storage.saveTodayState(stateData);
  },

  restoreTodayState() {
    const saved = Storage.getTodayState();
    if (!saved) return;

    // 检查是否是今天的数据
    const today = TimeUtils.getBeijingDateStr();
    if (saved.date !== today) {
      Storage.clearTodayState();
      return;
    }

    // 恢复状态
    this.state = saved.state;
    this.startTime = saved.startTime;
    this.homeworkSeconds = saved.homeworkSeconds || 0;
    this.pausedSeconds = saved.pausedSeconds || 0;
    this.pauseStart = saved.pauseStart || null;
    this.frozenRemainingSeconds = saved.frozenRemainingSeconds || null;

    // 如果之前是暂停状态，恢复暂停时间
    if (this.state === STATE.PAUSED && saved.pauseStart) {
      // 暂停时间从保存时刻继续计算
      this.pausedSeconds += Math.floor((Date.now() - saved.pauseStart) / 1000);
      this.pauseStart = Date.now();
    }

    // 如果之前是运行状态，调整 lastTick
    if (this.state === STATE.RUNNING) {
      this.lastTick = Date.now();
      this.startTimer();
      this.startEncouragementRotation();
    }

    if (this.state === STATE.PAUSED) {
      this.showPausedOverlay();
    }

    if (this.state === STATE.REVIEWING) {
      this.showParentConfirm();
    }

    this.updateUI();
    this.updateTimerDisplay();
  },

  // ---------- 家长数据页面 ----------

  showStatsPage() {
    document.getElementById('page-timer').classList.remove('active');
    document.getElementById('page-timer').style.display = 'none';

    const page = document.getElementById('page-stats');
    page.style.display = '';
    page.classList.add('active');

    // 重置 PIN 输入
    document.getElementById('pin-input').value = '';
    document.getElementById('pin-area').style.display = '';
    document.getElementById('stats-content').style.display = 'none';
  },

  hideStatsPage() {
    document.getElementById('page-stats').classList.remove('active');
    document.getElementById('page-stats').style.display = 'none';

    const page = document.getElementById('page-timer');
    page.style.display = '';
    page.classList.add('active');
  },

  verifyPin() {
    const input = document.getElementById('pin-input').value;
    if (input === this.settings.parentPin) {
      document.getElementById('pin-area').style.display = 'none';
      document.getElementById('stats-content').style.display = '';
      this.loadStatsData();
      this.loadSettings();
    } else {
      document.getElementById('pin-input').value = '';
      document.getElementById('pin-input').classList.add('shake');
      setTimeout(() => document.getElementById('pin-input').classList.remove('shake'), 500);
    }
  },

  loadStatsData() {
    const records = Storage.getRecords();
    this.renderStats(records, 7);
  },

  switchTab(btn) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const range = parseInt(btn.dataset.range);
    const records = Storage.getRecords();
    this.renderStats(records, range);
  },

  renderStats(records, days) {
    // 过滤最近 N 天的记录
    const now = TimeUtils.getBeijingNow();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = TimeUtils.getBeijingDateStr(cutoff);

    const filtered = records.filter(r => r.date >= cutoffStr);

    // 计算统计数据
    const completedRecords = filtered.filter(r =>
      r.checklist && r.checklist.homeworkDone && r.checklist.correctionsDone && r.checklist.attitudeGood
    );

    const avgHomework = completedRecords.length > 0
      ? completedRecords.reduce((sum, r) => sum + r.homeworkDurationSeconds, 0) / completedRecords.length
      : 0;

    const avgHappy = completedRecords.length > 0
      ? completedRecords.reduce((sum, r) => sum + r.remainingSeconds, 0) / completedRecords.length
      : 0;

    // 本周星星数（全部确认完成的记录数）
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const weekStartStr = TimeUtils.getBeijingDateStr(weekStart);
    const weekRecords = records.filter(r => r.date >= weekStartStr && r.checklist &&
      r.checklist.homeworkDone && r.checklist.correctionsDone && r.checklist.attitudeGood);

    document.getElementById('stat-avg-homework').textContent = avgHomework > 0
      ? TimeUtils.formatDurationShort(Math.floor(avgHomework))
      : '--';
    document.getElementById('stat-avg-happy').textContent = avgHappy > 0
      ? TimeUtils.formatDurationShort(Math.floor(avgHappy))
      : '--';
    document.getElementById('stat-stars').textContent = `${weekRecords.length} ⭐`;

    // 渲染星星图
    this.renderStarsGrid(records, now);

    // 渲染记录列表
    this.renderRecordsList(filtered);
  },

  renderStarsGrid(records, now) {
    const grid = document.getElementById('stars-grid');
    grid.innerHTML = '';

    // 获取本周每天的日期
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());

    for (let i = 0; i < 7; i++) {
      const day = new Date(weekStart);
      day.setDate(day.getDate() + i);
      const dateStr = TimeUtils.getBeijingDateStr(day);
      const dayName = ['日', '一', '二', '三', '四', '五', '六'][i];

      const dayRecord = records.find(r => r.date === dateStr);
      const isToday = dateStr === TimeUtils.getBeijingDateStr(now);

      let stars = '';
      if (dayRecord) {
        const checks = dayRecord.checklist || {};
        const count = (checks.homeworkDone ? 1 : 0) + (checks.correctionsDone ? 1 : 0) + (checks.attitudeGood ? 1 : 0);
        stars = '⭐'.repeat(count) + '☆'.repeat(3 - count);
      } else {
        stars = '☆☆☆';
      }

      const div = document.createElement('div');
      div.className = `star-day${!dayRecord ? ' empty' : ''}${isToday ? ' today' : ''}`;
      div.innerHTML = `
        <div class="day-name">周${dayName}</div>
        <div class="day-stars">${stars}</div>
        <div class="day-date">${day.getMonth() + 1}/${day.getDate()}</div>
      `;
      grid.appendChild(div);
    }
  },

  renderRecordsList(records) {
    const list = document.getElementById('records-list');
    list.innerHTML = '';

    if (records.length === 0) {
      list.innerHTML = '<div class="record-empty">还没有记录哦，开始今天的第一次作业吧！</div>';
      return;
    }

    // 倒序显示（最新的在前）
    const sorted = [...records].reverse();

    sorted.forEach(record => {
      const card = document.createElement('div');
      card.className = 'record-card';

      const homeworkTime = TimeUtils.formatDurationShort(record.homeworkDurationSeconds);
      const happyTime = TimeUtils.formatDurationShort(record.remainingSeconds);
      const allChecked = record.checklist &&
        record.checklist.homeworkDone &&
        record.checklist.correctionsDone &&
        record.checklist.attitudeGood;
      const isCallItADay = record.callItADay;

      // 状态标签
      let statusTag = '';
      if (isCallItADay) {
        statusTag = '🌙 今天到这了';
      } else if (allChecked) {
        statusTag = '✅ 全部完成';
      } else {
        statusTag = '📝 部分完成';
      }

      card.innerHTML = `
        <div class="record-date">${record.date} ${statusTag}</div>
        <div class="record-details">
          <div class="record-detail">
            <span class="label">开始时间</span>
            <span class="value">${record.startTime || '--'}</span>
          </div>
          <div class="record-detail">
            <span class="label">完成时间</span>
            <span class="value">${record.finishTime || '--'}</span>
          </div>
          <div class="record-detail">
            <span class="label">作业用时</span>
            <span class="value">${homeworkTime}</span>
          </div>
          <div class="record-detail">
            <span class="label">快乐时间</span>
            <span class="value">${isCallItADay ? '—' : happyTime}</span>
          </div>
        </div>
        ${!isCallItADay && record.checklist ? `
        <div class="record-checklist">
          ${(record.checklist.homeworkDone ? '✅' : '⬜')} 作业
          ${(record.checklist.correctionsDone ? '✅' : '⬜')} 订正
          ${(record.checklist.attitudeGood ? '✅' : '⬜')} 认真
        </div>` : ''}
        <div class="record-title">
          ${record.title || ''}${record.rewardChoice ? ' · ' + record.rewardChoice : ''}
        </div>
      `;
      list.appendChild(card);
    });
  },

  // ---------- 设置 ----------

  loadSettings() {
    document.getElementById('setting-bedtime').value = this.settings.bedtime;
    document.getElementById('setting-pin').value = '';
  },

  saveSettings() {
    const bedtime = document.getElementById('setting-bedtime').value;
    const pin = document.getElementById('setting-pin').value;

    if (bedtime) this.settings.bedtime = bedtime;
    if (pin && /^\d{4}$/.test(pin)) this.settings.parentPin = pin;

    Storage.saveSettings(this.settings);

    // 更新页面上的睡觉时间显示
    const [h, m] = this.settings.bedtime.split(':');
    document.querySelector('.bedtime-info').textContent = `💤 睡觉时间：晚上 ${h}:${m}`;

    // 显示保存成功提示
    const btn = document.getElementById('btn-save-settings');
    const originalText = btn.textContent;
    btn.textContent = '✅ 已保存';
    setTimeout(() => { btn.textContent = originalText; }, 1500);
  },

  exportData() {
    const records = Storage.getRecords();
    const settings = Storage.getSettings();
    const data = { records, settings, exportDate: new Date().toISOString() };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `homework-data-${TimeUtils.getBeijingDateStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  clearAllData() {
    if (confirm('警告：这将会清除所有的作业记录和设置（此操作不可恢复）！\n\n您确定要继续吗？')) {
      localStorage.clear();
      alert('所有数据已清空。');
      location.reload();
    }
  },

  // ---------- PWA Service Worker ----------

  registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js')
        .then(reg => console.log('Service Worker registered:', reg.scope))
        .catch(err => console.warn('Service Worker registration failed:', err));
    }
  }
};

// =============================================
// 五、启动应用
// =============================================

document.addEventListener('DOMContentLoaded', () => {
  App.init();
});
