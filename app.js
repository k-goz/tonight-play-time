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

/** 计时刷新间隔（毫秒） */
const TICK_INTERVAL = 200;

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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[character]);
}

// =============================================
// 三、存储工具
// =============================================

const Storage = {
  accountUserId: null,
  activeChildId: null,

  useAccount(userId, childId = null) {
    this.accountUserId = userId ? String(userId) : null;
    this.activeChildId = childId ? String(childId) : null;
  },

  scopedKey(key) {
    return this.accountUserId && this.activeChildId
      ? `${key}_user_${this.accountUserId}_child_${this.activeChildId}`
      : key;
  },

  has(key) {
    return localStorage.getItem(this.scopedKey(key)) !== null;
  },

  /**
   * 读取 JSON 数据
   */
  get(key, defaultValue) {
    try {
      const data = localStorage.getItem(this.scopedKey(key));
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
      localStorage.setItem(this.scopedKey(key), JSON.stringify(value));
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
    localStorage.removeItem(this.scopedKey(STORAGE_KEYS.TODAY_STATE));
  },

  /** 获取设置 */
  getSettings() {
    const defaults = this.accountUserId
      ? { bedtime: '21:30', weekendBedtime: '21:30' }
      : { bedtime: '21:30', weekendBedtime: '21:30', parentPin: '1234' };
    const stored = this.get(STORAGE_KEYS.SETTINGS, defaults);
    return {
      ...defaults,
      ...stored,
      weekendBedtime: stored.weekendBedtime || stored.bedtime || defaults.weekendBedtime
    };
  },

  /** 保存设置 */
  saveSettings(settings) {
    const safeSettings = this.accountUserId
      ? { bedtime: settings.bedtime, weekendBedtime: settings.weekendBedtime || settings.bedtime }
      : settings;
    this.set(STORAGE_KEYS.SETTINGS, safeSettings);
  },

  getLocalRecords() {
    return this.getRaw(STORAGE_KEYS.RECORDS, []);
  },

  getLocalSettings() {
    const settings = this.getRaw(STORAGE_KEYS.SETTINGS, {
      bedtime: '21:30',
      weekendBedtime: '21:30',
      parentPin: '1234'
    });
    return { ...settings, weekendBedtime: settings.weekendBedtime || settings.bedtime || '21:30' };
  },

  getLocalTodayState() {
    return this.getRaw(STORAGE_KEYS.TODAY_STATE, null);
  },

  getRaw(key, defaultValue) {
    try {
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : defaultValue;
    } catch (error) {
      console.warn('Storage read error:', error);
      return defaultValue;
    }
  },

  moveLocalTodayStateToAccount() {
    if (!this.accountUserId || !this.activeChildId || this.has(STORAGE_KEYS.TODAY_STATE)) return;
    const localState = this.getLocalTodayState();
    if (!localState) return;
    this.saveTodayState(localState);
    localStorage.removeItem(STORAGE_KEYS.TODAY_STATE);
  },

  markLocalRecordsMigrated(dates, userId) {
    const dateSet = new Set(dates);
    const records = this.getLocalRecords().map(record =>
      dateSet.has(record.date) && !record.migratedToAccount
        ? { ...record, migratedToAccount: String(userId) }
        : record
    );
    localStorage.setItem(STORAGE_KEYS.RECORDS, JSON.stringify(records));
  },

  migrateLegacyAccountScope(userId) {
    if (!this.accountUserId || !this.activeChildId) return;
    Object.values(STORAGE_KEYS).forEach(key => {
      const oldKey = `${key}_user_${userId}`;
      const newKey = this.scopedKey(key);
      const oldValue = localStorage.getItem(oldKey);
      if (oldValue !== null && localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, oldValue);
      }
    });
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

  async init() {
    // Initialize API service
    this.apiReady = false;
    this.currentSessionId = null;
    this.sessionPromise = null;
    this.lastPersistedBucket = -1;
    this.pendingLocalRecords = [];
    this.pendingLocalSettings = null;
    this.pendingRemoteSettingsInitialization = null;
    this.children = [];
    this.activeChild = null;
    this.parentApprovalToken = null;
    this.parentModeTimer = null;

    this.bindEvents();
    this.bindAuthEvents();

    // Check if user is logged in
    if (API_SERVICE.isLoggedIn()) {
      this.apiReady = true;
      this.user = API_SERVICE.user;
      console.log('User logged in:', this.user.nickname);
      try {
        await this.activateAccountStorage();
      } catch (error) {
        console.warn('Failed to load family profiles:', error);
        this.apiReady = false;
        API_SERVICE.logout();
        Storage.useAccount(null);
      }
    } else {
      Storage.useAccount(null);
    }

    this.settings = Storage.getSettings();
    this.updateBedtimeDisplay();
    if (this.apiReady || localStorage.getItem('skip_auth') === 'true') {
      this.restoreTodayState();
    }
    this.updateUI();
    this.updateTimerDisplay();
    this.startClock();
    this.registerSW();
    this.checkAuthState();
  },

  updateBedtimeDisplay() {
    const bedtime = this.getCurrentBedtime();
    const [h, m] = bedtime.split(':');
    const ruleLabel = TimeUtils.isWeekend() ? '周末' : '工作日';
    document.querySelector('.bedtime-info').textContent = `💤 今晚睡觉：${h}:${m}（${ruleLabel}）`;
  },

  getCurrentBedtime(date = TimeUtils.getBeijingNow()) {
    return TimeUtils.getBedtimeForDate(this.settings, date);
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
    document.getElementById('btn-lock-parent').addEventListener('click', () => this.lockParentMode());
    document.getElementById('btn-completion-pin').addEventListener('click', () => this.verifyCompletionPin());
    document.getElementById('completion-pin-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.verifyCompletionPin();
    });

    // 数据页签切换
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn));
    });

    // 设置保存
    document.getElementById('btn-save-settings').addEventListener('click', () => this.saveSettings());
    document.getElementById('child-selector').addEventListener('change', (event) => {
      this.switchChild(Number(event.target.value));
    });
    document.getElementById('btn-add-child').addEventListener('click', () => this.addChildProfile());
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
      await this.activateAccountStorage();
      this.loadStorageContext();
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

    if (password.length < 8) {
      errorEl.textContent = '密码至少8位';
      errorEl.style.display = 'block';
      return;
    }

    try {
      await API_SERVICE.register(username, nickname, password);
      this.user = API_SERVICE.user;
      this.apiReady = true;
      await this.activateAccountStorage(API_SERVICE.user.child_id);
      this.loadStorageContext();
      this.enterApp();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.style.display = 'block';
    }
  },

  skipAuth() {
    localStorage.setItem('skip_auth', 'true');
    this.apiReady = false;
    this.user = null;
    Storage.useAccount(null);
    this.children = [];
    this.activeChild = null;
    this.renderChildSwitcher();
    this.loadStorageContext();
    this.enterApp();
  },

  async activateAccountStorage(preferredChildId = null) {
    if (!this.user?.user_id) return;
    this.pendingLocalRecords = Storage.getLocalRecords().filter(record => !record.migratedToAccount);
    this.pendingLocalSettings = localStorage.getItem(STORAGE_KEYS.SETTINGS)
      ? Storage.getLocalSettings()
      : null;
    this.children = await API_SERVICE.getChildren();
    const activeChildren = this.children.filter(child => !child.archived_at);
    if (activeChildren.length === 0) throw new Error('账号缺少可用的孩子档案');

    const savedChildId = Number(localStorage.getItem(`active_child_user_${this.user.user_id}`));
    this.activeChild = activeChildren.find(child => child.id === Number(preferredChildId)) ||
      activeChildren.find(child => child.id === savedChildId) ||
      activeChildren.find(child => child.is_default) ||
      activeChildren[0];
    Storage.useAccount(this.user.user_id, this.activeChild.id);
    Storage.migrateLegacyAccountScope(this.user.user_id);

    if (!Storage.has(STORAGE_KEYS.SETTINGS)) {
      Storage.saveSettings({
        bedtime: this.activeChild.bedtime || this.pendingLocalSettings?.bedtime || '21:30',
        weekendBedtime: this.activeChild.weekend_bedtime ||
          this.pendingLocalSettings?.weekendBedtime || this.pendingLocalSettings?.bedtime ||
          this.activeChild.bedtime
      });
    }
    Storage.moveLocalTodayStateToAccount();
    localStorage.setItem(`active_child_user_${this.user.user_id}`, String(this.activeChild.id));
    this.renderChildSwitcher();
  },

  loadStorageContext() {
    this.stopTimer();
    this.stopEncouragementRotation();
    this.state = STATE.IDLE;
    this.startTime = null;
    this.homeworkSeconds = 0;
    this.pausedSeconds = 0;
    this.pauseStart = null;
    this.frozenRemainingSeconds = null;
    this.currentSessionId = null;
    this.sessionPromise = null;
    this.lastPersistedBucket = -1;
    this.settings = Storage.getSettings();
    this.updateBedtimeDisplay();
    this.restoreTodayState();
    this.updateUI();
    this.updateTimerDisplay();
  },

  enterApp() {
    document.getElementById('page-auth').classList.remove('active');
    document.getElementById('page-auth').style.display = 'none';
    document.getElementById('page-timer').classList.add('active');
    document.getElementById('page-timer').style.display = 'block';

    if (this.apiReady) {
      this.syncFromServer();
    }
  },

  renderChildSwitcher() {
    const switcher = document.getElementById('child-switcher');
    const selector = document.getElementById('child-selector');
    const avatar = document.getElementById('active-child-avatar');
    if (!this.apiReady || !this.activeChild) {
      switcher.style.display = 'none';
      selector.innerHTML = '';
      return;
    }

    selector.innerHTML = this.children.filter(child => !child.archived_at).map(child =>
      `<option value="${child.id}"${child.id === this.activeChild.id ? ' selected' : ''}>${escapeHtml(child.name)}</option>`
    ).join('');
    avatar.textContent = this.activeChild.avatar || '🌙';
    switcher.style.display = 'flex';
  },

  async switchChild(childId) {
    if (!this.apiReady || childId === this.activeChild?.id) return;
    if (![STATE.IDLE, STATE.COMPLETED].includes(this.state)) {
      alert('当前孩子正在计时，请完成或重新开始后再切换。');
      this.renderChildSwitcher();
      return;
    }

    const child = this.children.find(item => item.id === childId && !item.archived_at);
    if (!child) return;
    this.activeChild = child;
    Storage.useAccount(this.user.user_id, child.id);
    localStorage.setItem(`active_child_user_${this.user.user_id}`, String(child.id));
    if (!Storage.has(STORAGE_KEYS.SETTINGS)) {
      Storage.saveSettings({
        bedtime: child.bedtime,
        weekendBedtime: child.weekend_bedtime || child.bedtime
      });
    }
    this.renderChildSwitcher();
    const statsOpen = document.getElementById('page-stats').classList.contains('active');
    this.loadStorageContext();
    await this.syncFromServer({ restoreToday: !statsOpen });

    if (statsOpen) {
      this.loadStatsData();
      this.loadSettings();
      this.renderFamilyProfiles();
    }
  },

  async addChildProfile() {
    if (!this.apiReady) return;
    const nameInput = document.getElementById('new-child-name');
    const avatarInput = document.getElementById('new-child-avatar');
    const bedtimeInput = document.getElementById('new-child-bedtime');
    const weekendBedtimeInput = document.getElementById('new-child-weekend-bedtime');
    const button = document.getElementById('btn-add-child');
    const message = document.getElementById('child-profile-message');
    const name = nameInput.value.trim();
    if (!name) {
      message.textContent = '请输入孩子昵称';
      return;
    }

    button.disabled = true;
    button.textContent = '正在添加…';
    try {
      const child = await API_SERVICE.createChild({
        name,
        avatar: avatarInput.value,
        bedtime: bedtimeInput.value,
        weekend_bedtime: weekendBedtimeInput.value
      });
      this.children = await API_SERVICE.getChildren();
      nameInput.value = '';
      message.textContent = `已添加 ${child.name}`;
      await this.switchChild(child.id);
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
      button.textContent = '＋ 添加孩子';
      this.renderFamilyProfiles();
    }
  },

  renderFamilyProfiles() {
    const section = document.getElementById('family-section');
    const list = document.getElementById('family-profile-list');
    if (!this.apiReady) {
      section.style.display = 'none';
      list.innerHTML = '';
      return;
    }

    section.style.display = '';
    list.innerHTML = this.children.map(child => {
      const archived = Boolean(child.archived_at);
      const active = child.id === this.activeChild?.id;
      return `
        <div class="family-profile-card${active ? ' active' : ''}${archived ? ' archived' : ''}">
          <button type="button" class="profile-select" data-child-id="${child.id}"
            ${archived ? 'disabled' : ''} aria-pressed="${active}" aria-label="切换到${escapeHtml(child.name)}">
            <span class="profile-avatar">${escapeHtml(child.avatar || '🌙')}</span>
            <span>
              <span class="profile-name">${escapeHtml(child.name)}${child.is_default ? ' · 默认档案' : ''}</span>
              <span class="profile-meta">${archived ? '已归档 · 数据保留' : `工作日 ${escapeHtml(child.bedtime)} · 周末 ${escapeHtml(child.weekend_bedtime || child.bedtime)}`}</span>
            </span>
          </button>
          ${child.is_default ? '' : `<button type="button" class="profile-archive" data-archive-child-id="${child.id}" data-archived="${archived}">${archived ? '恢复档案' : '归档档案'}</button>`}
        </div>
      `;
    }).join('');
    list.querySelectorAll('[data-child-id]').forEach(button => {
      button.addEventListener('click', () => this.switchChild(Number(button.dataset.childId)));
    });
    list.querySelectorAll('[data-archive-child-id]').forEach(button => {
      button.addEventListener('click', () => this.setChildArchived(
        Number(button.dataset.archiveChildId),
        button.dataset.archived !== 'true'
      ));
    });
  },

  async setChildArchived(childId, archived) {
    const child = this.children.find(item => item.id === childId);
    const message = document.getElementById('child-profile-message');
    if (!child || child.is_default) return;
    if (archived && child.id === this.activeChild?.id && ![STATE.IDLE, STATE.COMPLETED].includes(this.state)) {
      message.textContent = '当前孩子正在计时，请先完成或重新开始后再归档。';
      return;
    }
    if (archived && !confirm(`归档“${child.name}”？历史记录会保留，之后可以恢复。`)) return;

    try {
      await API_SERVICE.setChildArchived(childId, archived);
      this.children = await API_SERVICE.getChildren();
      const activeStillAvailable = this.children.find(item =>
        item.id === this.activeChild?.id && !item.archived_at
      );
      if (!activeStillAvailable) {
        this.activeChild = this.children.find(item => item.is_default && !item.archived_at) ||
          this.children.find(item => !item.archived_at);
        Storage.useAccount(this.user.user_id, this.activeChild.id);
        localStorage.setItem(`active_child_user_${this.user.user_id}`, String(this.activeChild.id));
        this.loadStorageContext();
        await this.syncFromServer({ restoreToday: false });
      }
      message.textContent = archived ? `已归档 ${child.name}，历史记录仍保留` : `已恢复 ${child.name}`;
      this.renderChildSwitcher();
      this.loadSettings();
      this.renderFamilyProfiles();
      this.loadStatsData();
    } catch (error) {
      message.textContent = error.message;
    }
  },

  addUserInfoToHeader() {
    const headerRight = document.querySelector('.header-right');
    const existingInfo = document.querySelector('.user-info');
    if (existingInfo) return;

    const userInfo = document.createElement('div');
    userInfo.className = 'user-info';
    const avatar = document.createElement('span');
    avatar.className = 'user-avatar';
    avatar.textContent = this.user.nickname.charAt(0);
    const nickname = document.createElement('span');
    nickname.textContent = this.user.nickname;
    userInfo.append(avatar, nickname);
    headerRight.insertBefore(userInfo, headerRight.firstChild);
  },

  async syncFromServer({ restoreToday = true } = {}) {
    if (!this.apiReady) return;

    try {
      await this.syncSettingsFromServer();
      if (API_SERVICE.hasParentAccess()) await this.migrateLocalRecordsToServer();
      const today = TimeUtils.getBeijingDateStr();
      const sessions = await API_SERVICE.getSessions(this.activeChild.id, 100);
      const todaySession = sessions.find(s => s.date === today);

      this.mergeServerRecords(sessions);

      if (todaySession) {
        this.currentSessionId = todaySession.id;
        if (!restoreToday) {
          this.restoreFromServerSession(todaySession, { showSurfaces: false });
          return;
        }
        const localState = Storage.getTodayState();
        if (todaySession.completed) {
          this.restoreFromServerSession(todaySession);
        } else if (localState && localState.date === today && localState.state !== STATE.COMPLETED) {
          await this.syncCurrentSession();
        } else {
          this.restoreFromServerSession(todaySession);
        }
      }

      console.log('Data synced from server');
    } catch (error) {
      console.warn('Failed to sync from server:', error);
    }
  },

  async syncSettingsFromServer() {
    const remoteSettings = await API_SERVICE.getSettings(this.activeChild.id);
    if (!remoteSettings.initialized) {
      const initialSettings = this.pendingLocalSettings || this.settings;
      this.settings = {
        bedtime: initialSettings.bedtime,
        weekendBedtime: initialSettings.weekendBedtime || initialSettings.bedtime
      };
      this.pendingRemoteSettingsInitialization = {
        pinConfigured: remoteSettings.pin_configured,
        parentPin: initialSettings.parentPin || '1234'
      };
    } else {
      this.pendingRemoteSettingsInitialization = null;
      this.settings = {
        bedtime: remoteSettings.bedtime,
        weekendBedtime: remoteSettings.weekend_bedtime || remoteSettings.bedtime
      };
    }
    this.activeChild = {
      ...this.activeChild,
      bedtime: this.settings.bedtime,
      weekend_bedtime: this.settings.weekendBedtime
    };
    this.children = this.children.map(child =>
      child.id === this.activeChild.id ? this.activeChild : child
    );
    Storage.saveSettings(this.settings);
    this.updateBedtimeDisplay();
    this.renderChildSwitcher();
  },

  async initializeRemoteSettingsIfNeeded() {
    if (!this.apiReady || !this.pendingRemoteSettingsInitialization) return;
    const payload = {
      bedtime: this.settings.bedtime,
      weekend_bedtime: this.settings.weekendBedtime
    };
    if (!this.pendingRemoteSettingsInitialization.pinConfigured) {
      payload.parent_pin = this.pendingRemoteSettingsInitialization.parentPin;
    }
    await API_SERVICE.updateSettings(this.activeChild.id, payload);
    this.pendingRemoteSettingsInitialization = null;
  },

  localRecordToImport(record) {
    const checklist = record.checklist || {};
    return {
      date: record.date,
      bedtime: this.getCurrentBedtime(record.date),
      start_time: record.startTime || null,
      end_time: record.finishTime || null,
      homework_seconds: Math.max(0, Number(record.homeworkDurationSeconds) || 0),
      paused_seconds: Math.max(0, Number(record.pausedDurationSeconds) || 0),
      remaining_seconds: Math.max(0, Number(record.remainingSeconds) || 0),
      homework_done: Boolean(checklist.homeworkDone),
      correction_done: Boolean(checklist.correctionsDone),
      attitude_good: Boolean(checklist.attitudeGood),
      reward_choice: record.rewardChoice || null,
      title: record.title || null,
      call_it_a_day: Boolean(record.callItADay)
    };
  },

  async migrateLocalRecordsToServer() {
    const records = this.pendingLocalRecords
      .filter(record => /^\d{4}-\d{2}-\d{2}$/.test(record.date || ''))
      .slice(0, 100);
    if (records.length === 0) return;

    await API_SERVICE.importSessions(
      this.activeChild.id,
      records.map(record => this.localRecordToImport(record))
    );
    Storage.markLocalRecordsMigrated(records.map(record => record.date), this.user.user_id);
    this.pendingLocalRecords = [];
  },

  restoreFromServerSession(session, { showSurfaces = true } = {}) {
    const serverState = Object.values(STATE).includes(session.state) ? session.state : STATE.IDLE;
    this.state = session.completed ? STATE.COMPLETED : serverState;
    this.startTime = session.start_time || null;
    this.homeworkSeconds = session.homework_seconds || session.homework_minutes * 60 || 0;
    this.pausedSeconds = session.paused_seconds || 0;
    this.frozenRemainingSeconds = session.remaining_seconds || null;
    this.lastPersistedBucket = Math.floor(this.homeworkSeconds / 30);

    if (this.state === STATE.RUNNING && this.startTime) {
      const elapsed = (Date.now() - new Date(this.startTime).getTime()) / 1000 - this.pausedSeconds;
      if (Number.isFinite(elapsed)) this.homeworkSeconds = Math.max(this.homeworkSeconds, elapsed);
    }

    if (this.state === STATE.COMPLETED) {
      const record = this.serverSessionToRecord(session);
      if (showSurfaces) {
        if (record.callItADay) this.showCallItADayPage(record);
        else this.showCelebration(record);
      } else {
        this.updateUI();
        this.updateTimerDisplay();
      }
      return;
    }

    if (this.state === STATE.RUNNING) {
      this.lastTick = Date.now();
      this.startTimer();
      this.startEncouragementRotation();
    } else if (this.state === STATE.PAUSED) {
      this.pauseStart = Date.now();
      if (showSurfaces) this.showPausedOverlay();
    } else if (this.state === STATE.REVIEWING) {
      if (showSurfaces) this.showParentConfirm();
    }

    this.saveTodayState();
    this.updateUI();
    this.updateTimerDisplay();
  },

  serverSessionToRecord(session) {
    const timePart = (value) => {
      if (!value) return '--';
      if (/^\d{2}:\d{2}/.test(value)) return value.slice(0, 8);
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? '--' : TimeUtils.getBeijingTimeStr(parsed);
    };

    return {
      serverSessionId: session.id,
      date: session.date,
      startTime: timePart(session.start_time),
      finishTime: timePart(session.end_time),
      homeworkDurationSeconds: session.homework_seconds || session.homework_minutes * 60 || 0,
      pausedDurationSeconds: session.paused_seconds || 0,
      remainingSeconds: session.remaining_seconds || session.playtime_minutes * 60 || 0,
      rewardChoice: session.reward_choice || session.playtime_type || '',
      title: session.title || '时间小管家',
      callItADay: Boolean(session.call_it_a_day),
      checklist: {
        homeworkDone: Boolean(session.homework_done),
        correctionsDone: Boolean(session.correction_done),
        attitudeGood: Boolean(session.attitude_good)
      }
    };
  },

  mergeServerRecords(sessions) {
    const records = Storage.getRecords();
    let changed = false;

    sessions.filter(session => session.completed).forEach(session => {
      const record = this.serverSessionToRecord(session);
      const index = records.findIndex(existing =>
        existing.serverSessionId === session.id || existing.date === session.date
      );
      if (index >= 0) records[index] = record;
      else records.push(record);
      changed = true;
    });

    if (changed) {
      records.sort((a, b) => a.date.localeCompare(b.date));
      Storage.saveRecords(records);
    }
  },

  async ensureServerSession() {
    if (!this.apiReady) return null;
    if (this.currentSessionId) return this.currentSessionId;
    if (!this.sessionPromise) {
      this.sessionPromise = API_SERVICE.createSession(
        this.activeChild.id,
        TimeUtils.getBeijingDateStr(),
        this.getCurrentBedtime()
      ).then(session => {
        this.currentSessionId = session.id;
        return session.id;
      }).finally(() => {
        this.sessionPromise = null;
      });
    }
    return this.sessionPromise;
  },

  async syncCurrentSession(extra = {}, { approvalToken = null, throwOnError = false } = {}) {
    if (!this.apiReady) return;
    try {
      const sessionId = await this.ensureServerSession();
      if (!sessionId) return;
      const payload = {
        state: this.state,
        homework_seconds: Math.max(0, this.homeworkSeconds),
        homework_minutes: Math.max(0, this.homeworkSeconds / 60),
        paused_seconds: Math.max(0, this.pausedSeconds),
        start_time: this.startTime,
        bedtime: this.getCurrentBedtime(),
        completed: this.state === STATE.COMPLETED,
        ...extra
      };
      await API_SERVICE.updateSession(sessionId, payload, {
        approvalToken,
        requiresParent: this.state === STATE.COMPLETED && API_SERVICE.hasParentAccess()
      });
    } catch (error) {
      console.warn('Failed to sync current session:', error);
      if (throwOnError) throw error;
    }
  },

  async handleLogout() {
    if (confirm('确定要退出登录吗？')) {
      await API_SERVICE.revokeToken();
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
    this.lastPersistedBucket = 0;

    this.saveTodayState();
    this.updateUI();
    this.startTimer();
    this.startEncouragementRotation();
    this.syncCurrentSession();
  },

  pauseHomework() {
    SoundUtils.playPause();
    this.state = STATE.PAUSED;
    this.pauseStart = Date.now();
    this.stopTimer();
    this.saveTodayState();
    this.updateUI();
    this.showPausedOverlay();
    this.syncCurrentSession();
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
    this.syncCurrentSession();
  },

  finishHomework() {
    SoundUtils.playFinish();
    this.state = STATE.REVIEWING;
    this.stopTimer();
    this.stopEncouragementRotation();
    this.frozenRemainingSeconds = TimeUtils.getSecondsToBedtime(this.getCurrentBedtime());
    this.saveTodayState();
    this.updateUI();
    this.showParentConfirm();
    this.syncCurrentSession({ remaining_seconds: this.frozenRemainingSeconds });
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
    this.syncCurrentSession();

    // 显示提示
    this.showTemporaryTip('🕵️ 小侦探发现还有一点点需要修正，加油，马上就能解锁快乐时间！');
  },

  async confirmComplete() {
    const now = TimeUtils.getBeijingNow();
    const bedtimeStr = this.getCurrentBedtime(now);
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

    const confirmButton = document.getElementById('btn-confirm');
    confirmButton.disabled = true;
    confirmButton.textContent = '正在保存…';
    try {
      await this.syncCurrentSession({
        state: STATE.COMPLETED,
        end_time: now.toISOString(),
        completed: true,
        homework_done: record.checklist.homeworkDone,
        correction_done: record.checklist.correctionsDone,
        attitude_good: record.checklist.attitudeGood,
        playtime_minutes: remainingSeconds / 60,
        remaining_seconds: remainingSeconds,
        reward_choice: '',
        title: record.title,
        call_it_a_day: false
      }, { approvalToken: this.parentApprovalToken, throwOnError: true });
    } catch (error) {
      this.parentApprovalToken = null;
      document.getElementById('completion-review').style.display = 'none';
      document.getElementById('completion-pin-gate').style.display = '';
      document.getElementById('completion-pin-input').value = '';
      document.getElementById('completion-pin-message').textContent = error.message || '保存失败，请重新验证';
      confirmButton.textContent = '🎉 确认完成，解锁快乐时间';
      return;
    }

    // 保存记录
    Storage.addRecord(record);
    Storage.clearTodayState();

    this.state = STATE.COMPLETED;
    this.stopTimer();
    this.stopEncouragementRotation();
    this.hideParentConfirm();
    confirmButton.textContent = '🎉 确认完成，解锁快乐时间';
    this.showCelebration(record);
  },

  async callItADay() {
    SoundUtils.playClick();
    const now = TimeUtils.getBeijingNow();
    const bedtimeStr = this.getCurrentBedtime(now);
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

    const callItADayButton = document.getElementById('btn-call-it-a-day');
    callItADayButton.disabled = true;
    callItADayButton.textContent = '正在保存…';
    try {
      await this.syncCurrentSession({
        state: STATE.COMPLETED,
        end_time: now.toISOString(),
        completed: true,
        homework_done: record.checklist.homeworkDone,
        correction_done: record.checklist.correctionsDone,
        attitude_good: record.checklist.attitudeGood,
        playtime_minutes: 0,
        remaining_seconds: remainingSeconds,
        reward_choice: '',
        title: '',
        call_it_a_day: true
      }, { approvalToken: this.parentApprovalToken, throwOnError: true });
    } catch (error) {
      this.parentApprovalToken = null;
      document.getElementById('completion-review').style.display = 'none';
      document.getElementById('completion-pin-gate').style.display = '';
      document.getElementById('completion-pin-input').value = '';
      document.getElementById('completion-pin-message').textContent = error.message || '保存失败，请重新验证';
      callItADayButton.disabled = false;
      callItADayButton.textContent = '🌙 今天就到这吧';
      return;
    }

    // 保存记录
    Storage.addRecord(record);
    Storage.clearTodayState();

    this.state = STATE.COMPLETED;
    this.stopTimer();
    this.stopEncouragementRotation();
    this.hideParentConfirm();
    callItADayButton.disabled = false;
    callItADayButton.textContent = '🌙 今天就到这吧';
    this.showCallItADayPage(record);
  },

  async resetToday() {
    if (this.apiReady && this.state === STATE.COMPLETED && !API_SERVICE.hasParentAccess()) {
      alert('已完成记录受家长模式保护。请先进入家长模式，再重新开始今天。');
      return;
    }
    if (!confirm('确定要重新开始今天吗？当前的作业计时会被清除。')) return;

    const previousState = this.state;
    const serverSessionId = this.currentSessionId;
    if (this.apiReady && serverSessionId && previousState === STATE.COMPLETED) {
      try {
        await API_SERVICE.deleteSession(serverSessionId, { requiresParent: true });
      } catch (error) {
        alert(error.message || '已完成记录删除失败，请重新进入家长模式后重试。');
        return;
      }
    }
    this.state = STATE.IDLE;
    this.stopTimer();
    this.stopEncouragementRotation();
    Storage.clearTodayState();
    this.homeworkSeconds = 0;
    this.pausedSeconds = 0;
    this.startTime = null;
    this.currentSessionId = null;
    this.sessionPromise = null;
    this.lastPersistedBucket = -1;
    if (previousState === STATE.COMPLETED) {
      const today = TimeUtils.getBeijingDateStr();
      Storage.saveRecords(Storage.getRecords().filter(record => record.date !== today));
    }
    if (this.apiReady && serverSessionId && previousState !== STATE.COMPLETED) {
      API_SERVICE.deleteSession(serverSessionId).catch(error =>
        console.warn('Failed to delete server session:', error)
      );
    }
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

    // 每 30 秒保存并同步一次状态
    const bucket = Math.floor(this.homeworkSeconds / 30);
    if (bucket > this.lastPersistedBucket) {
      this.lastPersistedBucket = bucket;
      this.saveTodayState();
      this.syncCurrentSession();
    }
  },

  updateTimerDisplay() {
    const homeworkSec = Math.floor(this.homeworkSeconds);
    const remainingSec = TimeUtils.getSecondsToBedtime(this.getCurrentBedtime());

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
        btnReset.style.display = '';
        this.setEncouragement('今天的任务已经记录好啦，明天继续加油！');
        break;
    }
  },

  resetProgressDisplay() {
    document.getElementById('homework-time').textContent = '0 分钟';
    document.getElementById('happy-time').textContent = TimeUtils.formatDuration(
      TimeUtils.getSecondsToBedtime(this.getCurrentBedtime())
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
    this.parentApprovalToken = null;
    // 重置勾选状态
    document.getElementById('check-homework').checked = false;
    document.getElementById('check-corrections').checked = false;
    document.getElementById('check-attitude').checked = false;
    document.getElementById('btn-confirm').disabled = true;
    document.getElementById('parent-tip').style.display = 'none';
    document.getElementById('completion-pin-input').value = '';
    document.getElementById('completion-pin-message').textContent = this.apiReady
      ? '本次验证只用于确认作业，不会进入家长管理模式。'
      : '请输入本机家长密码。';
    document.getElementById('completion-pin-gate').style.display = '';
    document.getElementById('completion-review').style.display = 'none';

    document.getElementById('modal-parent').style.display = '';
  },

  hideParentConfirm() {
    this.parentApprovalToken = null;
    document.getElementById('modal-parent').style.display = 'none';
  },

  async verifyCompletionPin() {
    const input = document.getElementById('completion-pin-input').value;
    const button = document.getElementById('btn-completion-pin');
    const message = document.getElementById('completion-pin-message');
    if (!/^\d{4}$/.test(input)) {
      message.textContent = '请输入 4 位数字密码';
      return;
    }

    button.disabled = true;
    button.textContent = '验证中…';
    try {
      if (this.apiReady) {
        const result = await API_SERVICE.requestParentApproval(input);
        if (!result.valid) {
          message.textContent = '密码不正确，请重试';
          return;
        }
        this.parentApprovalToken = result.approval_token;
      } else if (input !== this.settings.parentPin) {
        message.textContent = '密码不正确，请重试';
        return;
      } else {
        this.parentApprovalToken = 'local-approved';
      }

      document.getElementById('completion-pin-gate').style.display = 'none';
      document.getElementById('completion-review').style.display = '';
      this.updateConfirmButton();
    } catch (error) {
      message.textContent = this.apiReady
        ? '网络不可用，账号模式需联网验证家长密码'
        : '验证失败，请重试';
    } finally {
      button.disabled = false;
      button.textContent = '家长验证';
    }
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

    document.querySelector('.reward-section').style.display = happyMinutes > 0 ? '' : 'none';

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
    if (this.apiReady && this.currentSessionId) {
      API_SERVICE.updateSession(this.currentSessionId, {
        playtime_type: btn.dataset.choice,
        reward_choice: btn.dataset.choice
      }).catch(error => console.warn('Failed to sync reward choice:', error));
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
      frozenRemainingSeconds: this.frozenRemainingSeconds,
      savedAt: Date.now()
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
    this.lastPersistedBucket = Math.floor(this.homeworkSeconds / 30);

    if (this.state === STATE.RUNNING && saved.savedAt) {
      this.homeworkSeconds += Math.max(0, (Date.now() - saved.savedAt) / 1000);
      this.lastPersistedBucket = Math.floor(this.homeworkSeconds / 30);
    }

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
    document.getElementById('pin-area').style.display = this.apiReady && API_SERVICE.hasParentAccess()
      ? 'none'
      : '';
    document.getElementById('stats-content').style.display = 'none';
    document.getElementById('btn-lock-parent').style.display = 'none';
    document.querySelector('.pin-hint').textContent = this.apiReady
      ? '验证后进入 15 分钟家长模式'
      : '默认密码：1234';
    if (this.apiReady && API_SERVICE.hasParentAccess()) this.enterParentMode();
  },

  hideStatsPage() {
    document.getElementById('page-stats').classList.remove('active');
    document.getElementById('page-stats').style.display = 'none';

    const page = document.getElementById('page-timer');
    page.style.display = '';
    page.classList.add('active');
    if (this.state === STATE.PAUSED) this.showPausedOverlay();
    if (this.state === STATE.REVIEWING) this.showParentConfirm();
  },

  async verifyPin() {
    const input = document.getElementById('pin-input').value;
    const button = document.getElementById('btn-pin');
    const hint = document.querySelector('.pin-hint');
    let valid = false;

    if (!/^\d{4}$/.test(input)) {
      hint.textContent = '请输入4位数字密码';
      this.showPinError();
      return;
    }

    button.disabled = true;
    button.textContent = '验证中…';
    try {
      if (this.apiReady) {
        const result = await API_SERVICE.verifyParentPin(input, 'manage');
        valid = result.valid;
      } else {
        valid = input === this.settings.parentPin;
      }
    } catch (error) {
      hint.textContent = '网络不可用，账号模式需联网验证家长密码';
    } finally {
      button.disabled = false;
      button.textContent = '确认';
    }

    if (valid) {
      await this.enterParentMode();
    } else {
      if (!hint.textContent.startsWith('网络不可用')) hint.textContent = '密码不正确，请重试';
      this.showPinError();
    }
  },

  async enterParentMode() {
    const hint = document.querySelector('.pin-hint');
    try {
      if (this.apiReady) {
        await this.initializeRemoteSettingsIfNeeded();
        await this.syncFromServer({ restoreToday: false });
      }
      document.getElementById('pin-area').style.display = 'none';
      document.getElementById('stats-content').style.display = '';
      document.getElementById('btn-lock-parent').style.display = '';
      this.loadStatsData();
      this.loadSettings();
      this.renderFamilyProfiles();
      this.scheduleParentModeLock();
    } catch (error) {
      document.getElementById('pin-area').style.display = '';
      document.getElementById('stats-content').style.display = 'none';
      document.getElementById('btn-lock-parent').style.display = 'none';
      hint.textContent = error.message || '家长模式加载失败，请重试';
    }
  },

  scheduleParentModeLock() {
    if (this.parentModeTimer) clearTimeout(this.parentModeTimer);
    if (!this.apiReady) return;
    const remaining = API_SERVICE.getParentRemainingMs();
    if (remaining <= 0) return this.lockParentMode({ revoke: false });
    this.parentModeTimer = setTimeout(
      () => this.lockParentMode({ revoke: false }),
      remaining + 50
    );
  },

  async lockParentMode({ revoke = true } = {}) {
    if (this.parentModeTimer) {
      clearTimeout(this.parentModeTimer);
      this.parentModeTimer = null;
    }
    if (this.apiReady) {
      if (revoke) await API_SERVICE.lockParentAccess().catch(() => API_SERVICE.clearParentAccess());
      else API_SERVICE.clearParentAccess();
    }
    if (document.getElementById('page-stats').classList.contains('active')) this.hideStatsPage();
  },

  showPinError() {
    const input = document.getElementById('pin-input');
    input.value = '';
    input.classList.add('shake');
    setTimeout(() => input.classList.remove('shake'), 500);
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
        <div class="record-date">${escapeHtml(record.date)} ${statusTag}</div>
        <div class="record-details">
          <div class="record-detail">
            <span class="label">开始时间</span>
            <span class="value">${escapeHtml(record.startTime || '--')}</span>
          </div>
          <div class="record-detail">
            <span class="label">完成时间</span>
            <span class="value">${escapeHtml(record.finishTime || '--')}</span>
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
          ${escapeHtml(record.title || '')}${record.rewardChoice ? ' · ' + escapeHtml(record.rewardChoice) : ''}
        </div>
      `;
      list.appendChild(card);
    });
  },

  // ---------- 设置 ----------

  loadSettings() {
    document.getElementById('setting-bedtime').value = this.settings.bedtime;
    document.getElementById('setting-weekend-bedtime').value =
      this.settings.weekendBedtime || this.settings.bedtime;
    document.getElementById('setting-pin').value = '';
    const nameItem = document.getElementById('setting-child-name-item');
    const nameInput = document.getElementById('setting-child-name');
    nameItem.style.display = this.apiReady ? 'flex' : 'none';
    nameInput.value = this.activeChild?.name || '';
  },

  async saveSettings() {
    const bedtime = document.getElementById('setting-bedtime').value;
    const weekendBedtime = document.getElementById('setting-weekend-bedtime').value;
    const pin = document.getElementById('setting-pin').value;
    const childName = document.getElementById('setting-child-name').value.trim();
    const btn = document.getElementById('btn-save-settings');
    const originalText = btn.textContent;

    if (pin && !/^\d{4}$/.test(pin)) {
      btn.textContent = '⚠️ 密码需4位数字';
      setTimeout(() => { btn.textContent = originalText; }, 2000);
      return;
    }

    if (this.apiReady && !childName) {
      btn.textContent = '⚠️ 请输入孩子昵称';
      setTimeout(() => { btn.textContent = originalText; }, 2000);
      return;
    }

    if (bedtime) this.settings.bedtime = bedtime;
    if (weekendBedtime) this.settings.weekendBedtime = weekendBedtime;
    if (pin && !this.apiReady) this.settings.parentPin = pin;

    Storage.saveSettings(this.settings);
    this.updateBedtimeDisplay();

    btn.disabled = true;
    btn.textContent = this.apiReady ? '正在同步…' : '✅ 已保存';
    try {
      if (this.apiReady) {
        const payload = {
          bedtime: this.settings.bedtime,
          weekend_bedtime: this.settings.weekendBedtime
        };
        if (pin) payload.parent_pin = pin;
        await API_SERVICE.updateSettings(this.activeChild.id, payload);
        if (childName !== this.activeChild.name ||
            bedtime !== this.activeChild.bedtime ||
            weekendBedtime !== (this.activeChild.weekend_bedtime || this.activeChild.bedtime)) {
          this.activeChild = await API_SERVICE.updateChild(this.activeChild.id, {
            name: childName,
            bedtime: this.settings.bedtime,
            weekend_bedtime: this.settings.weekendBedtime
          });
          this.children = this.children.map(child =>
            child.id === this.activeChild.id ? this.activeChild : child
          );
          this.renderChildSwitcher();
          this.renderFamilyProfiles();
        }
        if (this.currentSessionId || this.state !== STATE.IDLE) {
          await this.syncCurrentSession();
        }
        btn.textContent = '✅ 已同步';
      }
    } catch (error) {
      btn.textContent = '⚠️ 仅本地保存';
    } finally {
      btn.disabled = false;
      setTimeout(() => { btn.textContent = originalText; }, 2000);
    }
  },

  exportData() {
    const records = Storage.getRecords();
    const settings = Storage.getSettings();
    const data = {
      child: this.activeChild || null,
      records,
      settings,
      exportDate: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const childLabel = this.activeChild ? `-${this.activeChild.id}` : '';
    a.download = `homework-data${childLabel}-${TimeUtils.getBeijingDateStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  async clearAllData() {
    const childName = this.activeChild?.name || '当前孩子';
    if (!confirm(`警告：这将永久清除${childName}的全部作业记录（其他孩子、账号和设置会保留）。\n\n您确定要继续吗？`)) return;

    const button = document.getElementById('btn-clear-data');
    button.disabled = true;
    button.textContent = '正在清空…';
    try {
      if (this.apiReady) await API_SERVICE.deleteAllSessions(this.activeChild.id);
      Storage.saveRecords([]);
      Storage.clearTodayState();
      this.state = STATE.IDLE;
      this.currentSessionId = null;
      this.sessionPromise = null;
      alert(`${this.activeChild?.name || '当前孩子'}的作业记录已清空，账号和设置仍保留。`);
      location.reload();
    } catch (error) {
      button.disabled = false;
      button.textContent = '🗑️ 清空记录';
      alert('云端记录清空失败，请检查网络后重试。');
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
