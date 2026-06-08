# --- builder ---
FROM node:22-alpine AS builder
WORKDIR /app

# Install all deps (including dev) so we can build.
COPY package*.json ./
RUN npm ci

# Bring in source + Prisma schema, generate client, compile TS.
COPY . .
RUN npx prisma generate && npm run build

# --- runtime ---
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production

# Only ship compiled output + the Prisma client + prod deps.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/generated ./generated
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY package.json ./

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "dist/src/server.js"]
