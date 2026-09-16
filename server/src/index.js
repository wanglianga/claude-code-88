import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from './db.js';
import { seedIfEmpty } from './seed.js';
import { router } from './routes.js';
import { startJobs } from './jobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: '1mb' }));

// 简易请求日志
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    const t0 = Date.now();
    res.on('finish', () => console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t0}ms`));
  }
  next();
});

app.use('/api', router);

// 前端静态资源（生产构建产物）
const dist = path.resolve(__dirname, '../../web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) res.sendFile(path.join(dist, 'index.html'));
  });
}

// 统一 404 / 错误处理
app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: '服务器内部错误' });
});

async function main() {
  // 等待数据库就绪（compose 内首次启动 postgres 需要初始化时间）
  for (let i = 0; i < 30; i++) {
    try {
      await migrate();
      break;
    } catch (e) {
      console.log(`[boot] 等待数据库就绪... (${i + 1}/30) ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
      if (i === 29) throw e;
    }
  }
  await seedIfEmpty();
  startJobs();
  app.listen(PORT, () => console.log(`[boot] 洗衣房服务已启动: http://0.0.0.0:${PORT}`));
}

main().catch((e) => {
  console.error('[boot] 启动失败:', e);
  process.exit(1);
});
