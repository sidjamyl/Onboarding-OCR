FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY quality-templates ./quality-templates
COPY test ./test
RUN mkdir -p templates && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/templates ./templates
COPY --from=build --chown=node:node /app/config ./config
COPY --from=build --chown=node:node /app/quality-templates ./quality-templates
USER node
EXPOSE 8090
CMD ["node", "dist/src/server.js"]
