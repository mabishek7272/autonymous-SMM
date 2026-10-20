FROM node:22-alpine AS builder

# Prisma's engines need OpenSSL on Alpine
RUN apk add --no-cache openssl

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY prisma ./prisma
RUN npx prisma generate
RUN npm run build

# ── Production stage ──────────────────────────────────────────
FROM node:22-alpine AS runner

RUN apk add --no-cache openssl

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma

RUN mkdir -p logs

EXPOSE 3001
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
