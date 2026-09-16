# ---------- 阶段 1：构建前端 ----------
FROM node:20-alpine AS webbuild
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------- 阶段 2：安装后端生产依赖 ----------
FROM node:20-alpine AS serverdeps
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------- 阶段 3：运行时 ----------
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=serverdeps /build/server/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server/src ./server/src
COPY --from=webbuild /build/web/dist ./web/dist

# 非 root 运行
RUN chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/api/health >/dev/null 2>&1 || exit 1

CMD ["node", "server/src/index.js"]
