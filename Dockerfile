FROM node:22-alpine

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production
# Self-host defaults: one port everywhere, and the self-host policy (screenshots on; the customer owns this server).
ENV FBB_LISTEN_PORT=8767
ENV WORK_EDGE_POLICY=/app/deploy/selfhost/policy.json
VOLUME ["/data"]
EXPOSE 8767
USER node
CMD ["node", "broker/src/server.js"]
