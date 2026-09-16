<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { ROLE_HOME } from '../router';
import { err } from '../toast';

const auth = useAuthStore();
const router = useRouter();
const username = ref('');
const password = ref('');
const loading = ref(false);

const accounts = [
  { u: 'resident1', label: '居民·张伟' },
  { u: 'resident2', label: '居民·李娜' },
  { u: 'resident3', label: '居民·王强(低信用)' },
  { u: 'service1', label: '客服' },
  { u: 'cleaner1', label: '保洁' },
  { u: 'repair1', label: '维修' },
  { u: 'property1', label: '物业' },
];

function fill(u: string) {
  username.value = u;
  password.value = '123456';
}

async function submit() {
  if (!username.value || !password.value) return err('请输入用户名和密码');
  loading.value = true;
  try {
    await auth.login(username.value, password.value);
    router.push(ROLE_HOME[auth.user!.role]);
  } catch (e: any) {
    err(e.message);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-logo">🧺</div>
      <div class="login-title">净邻洗衣</div>
      <div class="login-sub">社区自助洗衣房 · 排队 / 故障 / 错拿协同处理平台</div>
      <div class="field">
        <label>用户名</label>
        <input class="input" v-model="username" placeholder="请输入用户名" @keyup.enter="submit" />
      </div>
      <div class="field">
        <label>密码</label>
        <input class="input" v-model="password" type="password" placeholder="请输入密码" @keyup.enter="submit" />
      </div>
      <button class="btn btn-primary btn-block" :disabled="loading" @click="submit">
        {{ loading ? '登录中...' : '登 录' }}
      </button>
      <div class="muted mt12" style="text-align:center">演示账号（密码均为 123456，点击填充）</div>
      <div class="quick-accounts">
        <button v-for="a in accounts" :key="a.u" @click="fill(a.u)">{{ a.label }}</button>
      </div>
    </div>
  </div>
</template>
