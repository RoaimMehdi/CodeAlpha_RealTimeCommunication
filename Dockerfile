FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first so Docker can cache this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application code
COPY server.js schema.sql ./
COPY scripts ./scripts
COPY public ./public

# Uploads live on a volume so files survive container rebuilds.
RUN mkdir -p /app/uploads && chown -R node:node /app

USER node
EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
