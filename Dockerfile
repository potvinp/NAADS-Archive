FROM node:22-slim

WORKDIR /app

# Installed separately from the rest of the source so this layer is only
# rebuilt when dependencies actually change, not on every code edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY src ./src
COPY public ./public
COPY bin ./bin

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# The bundled SQLite backend (default when no DATABASE_URL is set) writes
# to ./data -- owned by the unprivileged "node" user (already present in
# the base image) so the container doesn't run as root.
RUN mkdir -p data && chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/stats').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
