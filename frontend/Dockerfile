FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
ARG NEXT_PUBLIC_ONBOARDING_API_URL
ARG NEXT_PUBLIC_QUALITY_LAB_ENABLED=false
ARG NEXT_PUBLIC_DEMO_MODE_ENABLED=false
ARG NEXT_PUBLIC_OCR_SLOW_THRESHOLD_MS=20000
ENV NEXT_PUBLIC_ONBOARDING_API_URL=$NEXT_PUBLIC_ONBOARDING_API_URL
ENV NEXT_PUBLIC_QUALITY_LAB_ENABLED=$NEXT_PUBLIC_QUALITY_LAB_ENABLED
ENV NEXT_PUBLIC_DEMO_MODE_ENABLED=$NEXT_PUBLIC_DEMO_MODE_ENABLED
ENV NEXT_PUBLIC_OCR_SLOW_THRESHOLD_MS=$NEXT_PUBLIC_OCR_SLOW_THRESHOLD_MS
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN mkdir -p public && npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
