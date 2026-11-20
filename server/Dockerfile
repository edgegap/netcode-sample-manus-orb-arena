# Orb Arena game server for Edgegap (linux/amd64):
#   docker build --platform linux/amd64 -t registry.edgegap.com/<project>/orb-arena:<YYYYMMDD-HHMM> server
# Edgegap app version port: 8787, protocol WS, TLS Upgrade on (browsers connect with wss://<fqdn>:<external port>/ws).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
EXPOSE 8787/tcp
USER node
# Node is PID 1, so it receives Edgegap's SIGTERM directly.
CMD ["node", "src/server.js"]
