FROM node:22-slim

WORKDIR /app

# ffmpeg + a font: only needed for the optional continuous HLS alert channel
# (NAADS_STREAM=1). Harmless otherwise.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# Installed separately from the rest of the source so this layer is only
# rebuilt when dependencies actually change, not on every code edit.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY src ./src
COPY public ./public
COPY bin ./bin
# Fixed broadcast audio: the Alert Ready attention signal plus the
# pre-tone / post-message clips played around a broadcast-immediate alert.
COPY audio ./audio

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# The bundled SQLite backend (default when no DATABASE_URL is set) writes
# to ./data -- owned by the unprivileged "node" user (already present in
# the base image) so the container doesn't run as root.
RUN mkdir -p data && chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
