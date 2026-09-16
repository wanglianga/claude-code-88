<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';
import { ROLE_HOME } from './router';
import { ROLE_LABEL } from './utils';
import { toasts } from './toast';

const auth = useAuthStore();
const router = useRouter();
let timer: number | undefined;

onMounted(() => {
  timer = window.setInterval(() => { if (auth.user) auth.loadNotifications(); }, 20000);
});
onUnmounted(() => clearInterval(timer));

function logout() {
  auth.logout();
  router.push('/login');
}
function home() {
  if (auth.user) router.push(ROLE_HOME[auth.user.role]);
}
</script>

<template>
  <div>
    <div class="toast-wrap">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">{{ t.text }}</div>
    </div>

    <nav v-if="auth.user" class="navbar">
      <div class="navbar-inner">
        <div class="brand" style="cursor:pointer" @click="home">
          <div class="brand-logo">🧺</div>
          <span>净邻洗衣</span>
        </div>
        <div class="nav-links">
          <template v-if="auth.user.role === 'resident'">
            <router-link to="/" exact-active-class="active">设备预约</router-link>
            <router-link to="/orders" active-class="active">我的订单</router-link>
            <router-link to="/tickets" active-class="active">我的工单</router-link>
            <router-link to="/me" active-class="active">我的</router-link>
          </template>
          <template v-else-if="auth.user.role === 'service'">
            <router-link to="/tickets" active-class="active">工单中心</router-link>
          </template>
          <template v-else-if="auth.user.role === 'cleaner'">
            <router-link to="/cleaner" active-class="active">保洁工作台</router-link>
            <router-link to="/tickets" active-class="active">工单</router-link>
          </template>
          <template v-else-if="auth.user.role === 'maintenance'">
            <router-link to="/maintenance" active-class="active">维修工作台</router-link>
            <router-link to="/tickets" active-class="active">工单</router-link>
          </template>
          <template v-else-if="auth.user.role === 'property'">
            <router-link to="/dashboard" active-class="active">运营看板</router-link>
            <router-link to="/tickets" active-class="active">工单中心</router-link>
            <router-link to="/cleaner" active-class="active">保洁</router-link>
            <router-link to="/maintenance" active-class="active">维修</router-link>
          </template>
        </div>
        <div class="nav-user">
          <span class="credit-chip" :class="{ low: auth.user.credit < 60 }" v-if="auth.user.role === 'resident'">
            信用 {{ auth.user.credit }}
          </span>
          <span class="role-chip">{{ ROLE_LABEL[auth.user.role] }} · {{ auth.user.name }}</span>
          <button class="btn btn-ghost btn-sm" @click="logout">退出</button>
        </div>
      </div>
    </nav>

    <router-view />
  </div>
</template>
