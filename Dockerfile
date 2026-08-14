FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public

# Persisted data lives here — mount a volume in production so applications
# survive container restarts/redeploys.
RUN mkdir -p server/data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server/index.js"]
