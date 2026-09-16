import { reactive } from 'vue';

interface Toast { id: number; text: string; kind: 'success' | 'error' | 'info' }
export const toasts = reactive<Toast[]>([]);
let seq = 0;

export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = ++seq;
  toasts.push({ id, text, kind });
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }, 3200);
}
export const ok = (t: string) => toast(t, 'success');
export const err = (t: string) => toast(t, 'error');
