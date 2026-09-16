import { defineStore } from 'pinia';
import { api, setToken, clearToken } from '../api';
import type { User, Notification } from '../types';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null as User | null,
    notifications: [] as Notification[],
  }),
  getters: {
    isLogged: (s) => !!s.user,
    unread: (s) => s.notifications.filter((n) => !n.read).length,
  },
  actions: {
    async login(username: string, password: string) {
      const r = await api.post<{ token: string; user: User }>('/api/auth/login', { username, password });
      setToken(r.token);
      this.user = r.user;
      await this.refreshMe();
    },
    async refreshMe() {
      try {
        this.user = await api.get<User>('/api/auth/me');
      } catch {
        this.user = null;
      }
    },
    async loadNotifications() {
      if (!this.user) return;
      this.notifications = await api.get<Notification[]>('/api/notifications/mine');
    },
    async readAll() {
      await api.post('/api/notifications/read-all');
      await this.loadNotifications();
    },
    logout() {
      clearToken();
      this.user = null;
      this.notifications = [];
    },
  },
});
