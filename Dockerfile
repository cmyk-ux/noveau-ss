# Imagem do Noveau para servidor: o site compilado + a API (tokens, Discord) num container só.
# O LiveKit e o HTTPS (Caddy) sobem em containers separados, veja docker-compose.prod.yml.

# 1) Compila o site (Angular)
FROM node:22-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# 2) Dependências da API (sem as de desenvolvimento)
FROM node:22-slim AS api
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

# 3) Imagem final, pequena, sem root
FROM node:22-slim
ENV NODE_ENV=production \
    PORT=3000 \
    STATIC_DIR=/app/web
WORKDIR /app
COPY --from=api /src/server/node_modules ./server/node_modules
COPY server/package.json server/*.mjs ./server/
COPY --from=web /src/web/dist/noveau-ss/browser ./web
# Pasta do diário de travadas (volume app_data); precisa ser do usuário node.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/server.mjs"]
