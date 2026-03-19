FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY src/ src/
COPY docs/ docs/
COPY sdk/ sdk/

ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q --spider http://localhost:8080/api/v1/network/stats || exit 1

CMD ["node", "src/server.js"]
