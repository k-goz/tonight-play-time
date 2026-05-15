/**
 * API Service for tonight-play-time
 * Handles authentication and data sync with backend
 */

const API_SERVICE = {
  BASE_URL: '',  // Will be set based on deployment
  token: null,
  user: null,

  /**
   * Initialize API service
   */
  init() {
    // Try to load saved token
    this.token = localStorage.getItem('api_token');
    this.user = JSON.parse(localStorage.getItem('api_user') || 'null');
    
    // Set base URL - always use MacBook8 backend
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      this.BASE_URL = 'http://localhost:8001';
    } else {
      // Use MacBook8 Tailscale IP
      this.BASE_URL = 'http://100.81.234.57:8001';
    }

    console.log('API Service initialized, base URL:', this.BASE_URL);
  },

  /**
   * Make API request
   */
  async request(endpoint, options = {}) {
    const url = `${this.BASE_URL}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers
      });

      if (response.status === 401) {
        // Token expired or invalid
        this.logout();
        throw new Error('认证失败，请重新登录');
      }

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
    this.user = { user_id: data.user_id, nickname: data.nickname };
    
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
    localStorage.removeItem('api_token');
    localStorage.removeItem('api_user');
  },

  /**
   * Check if logged in
   */
  isLoggedIn() {
    return !!this.token && !!this.user;
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
   * Create homework session
   */
  async createSession(date, bedtime = '21:30') {
    return await this.request('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ date, bedtime })
    });
  },

  /**
   * Get sessions
   */
  async getSessions(limit = 30) {
    return await this.request(`/api/sessions?limit=${limit}`);
  },

  /**
   * Update session
   */
  async updateSession(sessionId, data) {
    return await this.request(`/api/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },

  /**
   * Delete session
   */
  async deleteSession(sessionId) {
    return await this.request(`/api/sessions/${sessionId}`, {
      method: 'DELETE'
    });
  },

  /**
   * Get statistics
   */
  async getStats(days = 30) {
    return await this.request(`/api/stats?days=${days}`);
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
