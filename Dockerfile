# syntax=docker/dockerfile:1

# ---- Build stage ----
FROM node:20-alpine AS builder
WORKDIR /app

# Install build toolchain for better-sqlite3 native module
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---- Dashboard build stage ----
FROM node:20-alpine AS dashboard
WORKDIR /app/dashboard

COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci

COPY dashboard/ ./
RUN npm run build

# ---- Runtime stage ----
FROM node:20-alpine
WORKDIR /app

# Re-install production deps with native modules compiled for the runtime image
COPY package.json package-lock.json ./
RUN apk add --no-cache python3 make g++ && \
    npm ci --production && \
    apk del python3 make g++

COPY --from=builder /app/dist ./dist
COPY --from=dashboard /app/dashboard/dist ./dashboard/dist

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
