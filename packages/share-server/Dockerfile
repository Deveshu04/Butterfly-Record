# No runtime dependencies to install; Node strips the TypeScript types at load time.
FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    BUTTERFLY_DATA_DIR=/data \
    PORT=8080 \
    HOST=0.0.0.0

VOLUME ["/data"]
EXPOSE 8080

# Run as the base image's unprivileged node user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.ts"]
