FROM node:24.14.1-alpine@sha256:6222c83590744c8e778520946b72d1cc4309293886610dc59a4ce3fdfe6f9b40 AS build
WORKDIR /build/integration-service
COPY integration-service/package*.json ./
RUN npm ci --no-audit --no-fund
COPY integration-service/ ./
RUN npm run build

FROM node:24.14.1-alpine@sha256:6222c83590744c8e778520946b72d1cc4309293886610dc59a4ce3fdfe6f9b40
WORKDIR /app
COPY --from=build /build/integration-service/package*.json ./
COPY --from=build /build/integration-service/node_modules ./node_modules
COPY --from=build /build/integration-service/dist ./dist
COPY --from=build /build/integration-service/migrations ./migrations
COPY deploy/alpha1/entrypoint.mjs ./deploy/alpha1/entrypoint.mjs
COPY deploy/alpha1/grant-probe.mjs ./deploy/alpha1/grant-probe.mjs
COPY deploy/alpha1/credential-revoke-sequence.mjs ./deploy/alpha1/credential-revoke-sequence.mjs
COPY deploy/alpha1/seed-principal.mjs ./deploy/alpha1/seed-principal.mjs
COPY deploy/alpha1/sales-probe.mjs ./deploy/alpha1/sales-probe.mjs
COPY deploy/alpha1/probe-transport.mjs ./deploy/alpha1/probe-transport.mjs
COPY deploy/alpha1/sales-revoke-http-probe.mjs ./deploy/alpha1/sales-revoke-http-probe.mjs
COPY deploy/alpha1/verify-audit.mjs ./deploy/alpha1/verify-audit.mjs
USER node
ENTRYPOINT ["node", "deploy/alpha1/entrypoint.mjs"]
