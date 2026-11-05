# syntax=docker/dockerfile:1

FROM node:24-alpine AS builder

WORKDIR /app

# Copy manifests first so dependency installation is cacheable and reproducible.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-alpine AS runner

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server.js stream-proxy.js search-utils.js catalog-utils.js catalog-filters.js provider-router.js content-utils.js catalog-cache.js catalog-fallback.js anilist-endpoint.js ./

# Modular backend packages required by server.js's import graph.
COPY --chown=node:node middleware ./middleware
COPY --chown=node:node routes ./routes
# Only the runtime Supabase client; *.sql migrations/schema notes stay out of the image.
COPY --chown=node:node supabase/client.js ./supabase/client.js

# Static assets served by express.static and read at boot (index.html, 404.html).
COPY --chown=node:node public ./public

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(response => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "server.js"]
