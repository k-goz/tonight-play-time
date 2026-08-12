/**
 * API Service for tonight-play-time
 * Handles authentication and data sync with backend
 */

const API_SERVICE = {
  BASE_URL: '',  // Will be set based on deployment
  token: null,
  user: null,
  parentToken: null,
  parentExpiresAt: 0,

  /**
   * Initialize API service
   */
  init() {
    // Try to load saved token
    this.token = localStorage.getItem('api_token');
    this.user = JSON.parse(localStorage.getItem('api_user') || 'null');
    this.parentToken = sessionStorage.getItem('parent_access_token');
    this.parentExpiresAt = Number(sessionStorage.getItem('parent_access_expires_at')) || 0;
    if (!this.hasParentAccess()) this.clearParentAccess();
    
    // Use relative URL (same origin) - works for both local and cloud deployment
    this.BASE_URL = '';

    console.log('API Service initialized, base URL:', this.BASE_URL || '(same origin)');
  },

  /**
   * Make API request
   */
  async request(endpoint, options = {}) {
    const url = `${this.BASE_URL}${endpoint}`;
    const { requiresParent = false, approvalToken = null, ...fetchOptions } = options;
    const headers = {
      'Content-Type': 'application/json',
      ...fetchOptions.headers
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (requiresParent && this.hasParentAccess()) {
      headers['X-Parent-Token'] = this.parentToken;
    }
    if (approvalToken) headers['X-Parent-Approval'] = approvalToken;

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        headers
      });

      if (response.status === 401) {
        // Token expired or invalid
        this.logout();
        throw new Error('认证失败，请重新登录');
      }
      if (response.status === 403 && requiresParent) this.clearParentAccess();

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.detail || '请求失败');
      }

      return await response.json();
    } catch (error) {
      console.error('API request failed:', error);
      throw error;
    }
  },

  /**
   * Register new user
   */
  async register(username, nickname, password) {
    const data = await this.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, nickname, password })
    });

    this.token = data.access_token;
    this.user = { user_id: data.user_id, child_id: data.child_id, nickname: data.nickname };
    
    localStorage.setItem('api_token', this.token);
    localStorage.setItem('api_user', JSON.stringify(this.user));

    return data;
  },

  /**
   * Login
   */
  async login(username, password) {
    const data = await this.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });

    this.token = data.access_token;
    this.user = { user_id: data.user_id, nickname: data.nickname };
    
    localStorage.setItem('api_token', this.token);
    localStorage.setItem('api_user', JSON.stringify(this.user));

    return data;
  },

  /**
   * Logout
   */
  logout() {
    this.token = null;
    this.user = null;
    this.clearParentAccess();
    localStorage.removeItem('api_token');
    localStorage.removeItem('api_user');
  },

  /**
   * Revoke the current server token, then always clear local credentials.
   */
  async revokeToken() {
    if (!this.token) {
      this.logout();
      return;
    }

    try {
      await this.request('/api/auth/logout', { method: 'POST' });
    } finally {
      this.logout();
    }
  },

  /**
   * Check if logged in
   */
  isLoggedIn() {
    return !!this.token && !!this.user;
  },

  hasParentAccess() {
    return Boolean(this.parentToken) && this.parentExpiresAt > Date.now();
  },

  getParentRemainingMs() {
    return this.hasParentAccess() ? Math.max(0, this.parentExpiresAt - Date.now()) : 0;
  },

  clearParentAccess() {
    this.parentToken = null;
    this.parentExpiresAt = 0;
    sessionStorage.removeItem('parent_access_token');
    sessionStorage.removeItem('parent_access_expires_at');
  },

  /**
   * Get current user
   */
  async getMe() {
    if (!this.isLoggedIn()) return null;
    
    try {
      const data = await this.request('/api/auth/me');
      this.user = { user_id: data.user_id, nickname: data.nickname };
      localStorage.setItem('api_user', JSON.stringify(this.user));
      return data;
    } catch (error) {
      this.logout();
      return null;
    }
  },

  /**
   * List child profiles owned by the signed-in family account.
   */
  async getChildren() {
    return await this.request('/api/children');
  },

  /**
   * Add a child profile to the family account.
   */
  async createChild(child) {
    return await this.request('/api/children', {
      method: 'POST',
      requiresParent: true,
      body: JSON.stringify(child)
    });
  },

  /**
   * Update a child profile owned by the family account.
   */
  async updateChild(childId, updates) {
    return await this.request(`/api/children/${childId}`, {
      method: 'PUT',
      requiresParent: true,
      body: JSON.stringify(updates)
    });
  },

  /**
   * Archive or restore a child profile without deleting its history.
   */
  async setChildArchived(childId, archived) {
    return await this.request(`/api/children/${childId}/archive`, {
      method: 'POST',
      requiresParent: true,
      body: JSON.stringify({ archived })
    });
  },

  /**
   * Get account-level parent settings. The PIN is never returned.
   */
  async getSettings(childId) {
    return await this.request(`/api/settings?child_id=${childId}`);
  },

  /**
   * Save bedtime and optionally replace the parent PIN.
   */
  async updateSettings(childId, settings) {
    return await this.request('/api/settings', {
      method: 'PUT',
      requiresParent: true,
      body: JSON.stringify({ ...settings, child_id: childId })
    });
  },

  /**
   * Verify the parent PIN without downloading it to the browser.
   */
  async verifyParentPin(parentPin, purpose = 'manage') {
    const data = await this.request('/api/settings/verify-pin', {
      method: 'POST',
      body: JSON.stringify({ parent_pin: parentPin, purpose })
    });
    if (data.valid && purpose === 'manage') {
      this.parentToken = data.parent_token;
      this.parentExpiresAt = data.expires_at;
      sessionStorage.setItem('parent_access_token', this.parentToken);
      sessionStorage.setItem('parent_access_expires_at', String(this.parentExpiresAt));
    }
    return data;
  },

  async requestParentApproval(parentPin) {
    return await this.verifyParentPin(parentPin, 'approve');
  },

  async lockParentAccess() {
    if (!this.hasParentAccess()) {
      this.clearParentAccess();
      return;
    }
    try {
      await this.request('/api/settings/parent-access', {
        method: 'DELETE',
        requiresParent: true
      });
    } finally {
      this.clearParentAccess();
    }
  },

  /**
   * Create homework session
   */
  async createSession(childId, date, bedtime = '21:30') {
    return await this.request('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ child_id: childId, date, bedtime })
    });
  },

  /**
   * Get sessions
   */
  async getSessions(childId, limit = 30) {
    return await this.request(`/api/sessions?child_id=${childId}&limit=${limit}`);
  },

  /**
   * Import completed records created in local-only mode.
   */
  async importSessions(childId, records) {
    return await this.request('/api/sessions/import', {
      method: 'POST',
      requiresParent: true,
      body: JSON.stringify({ child_id: childId, records })
    });
  },

  /**
   * Update session
   */
  async updateSession(sessionId, data, { approvalToken = null, requiresParent = false } = {}) {
    return await this.request(`/api/sessions/${sessionId}`, {
      method: 'PUT',
      approvalToken,
      requiresParent,
      body: JSON.stringify(data)
    });
  },

  /**
   * Delete session
   */
  async deleteSession(sessionId, { requiresParent = false } = {}) {
    return await this.request(`/api/sessions/${sessionId}`, {
      method: 'DELETE',
      requiresParent
    });
  },

  /**
   * Delete every session owned by the current account.
   */
  async deleteAllSessions(childId) {
    return await this.request(`/api/sessions?child_id=${childId}`, {
      method: 'DELETE',
      requiresParent: true
    });
  },

  /**
   * Get statistics
   */
  async getStats(childId, days = 30) {
    return await this.request(`/api/stats?child_id=${childId}&days=${days}`, {
      requiresParent: true
    });
  },

  /**
   * Get weekly stats
   */
  async getWeeklyStats() {
    return await this.request('/api/stats/weekly');
  },

  /**
   * Health check
   */
  async healthCheck() {
    try {
      const response = await fetch(`${this.BASE_URL}/api/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
};

// Initialize on load
API_SERVICE.init();
