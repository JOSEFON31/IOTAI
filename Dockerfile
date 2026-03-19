FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY docs/ ./docs/

EXPOSE 8080

CMD ["node", "src/server.js"]
