import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from './stores/auth';
import type { Role } from './types';

const HomeView = () => import('./views/HomeView.vue');
const OrdersView = () => import('./views/OrdersView.vue');
const MeView = () => import('./views/MeView.vue');
const TicketsView = () => import('./views/TicketsView.vue');
const CleanerView = () => import('./views/CleanerView.vue');
const MaintenanceView = () => import('./views/MaintenanceView.vue');
const DashboardView = () => import('./views/DashboardView.vue');
const LoginView = () => import('./views/LoginView.vue');

export const ROLE_HOME: Record<Role, string> = {
  resident: '/',
  service: '/tickets',
  cleaner: '/cleaner',
  maintenance: '/maintenance',
  property: '/dashboard',
};

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView, meta: { public: true } },
    { path: '/', component: HomeView, meta: { roles: ['resident'] } },
    { path: '/orders', component: OrdersView, meta: { roles: ['resident'] } },
    { path: '/me', component: MeView, meta: { roles: ['resident'] } },
    { path: '/tickets', component: TicketsView, meta: { roles: ['resident', 'service', 'cleaner', 'maintenance', 'property'] } },
    { path: '/cleaner', component: CleanerView, meta: { roles: ['cleaner', 'property'] } },
    { path: '/maintenance', component: MaintenanceView, meta: { roles: ['maintenance', 'property'] } },
    { path: '/dashboard', component: DashboardView, meta: { roles: ['property'] } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.user && !to.meta.public) {
    await auth.refreshMe();
  }
  if (!to.meta.public && !auth.user) return '/login';
  if (to.path === '/login' && auth.user) return ROLE_HOME[auth.user.role];
  const roles = to.meta.roles as Role[] | undefined;
  if (roles && auth.user && !roles.includes(auth.user.role)) return ROLE_HOME[auth.user.role];
  return true;
});

export default router;
