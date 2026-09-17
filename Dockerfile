# The game server. Not the client — that is a folder of static files and wants
# a CDN, not a container. See DEPLOY.md.
FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a change to the game does not re-fetch the world.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY shared/ ./shared/
COPY server/ ./server/
COPY client/ ./client/

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "server/index.js"]
