# Minimal image to run uci-to-tlcs in the docker-compose e2e test.
FROM node:20-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm install tsx
COPY tsconfig.json ./
COPY src ./src
COPY fixtures ./fixtures

# Overridden by docker-compose; broadcasts the sample game on UDP 16066.
ENTRYPOINT ["npx", "tsx", "src/main.ts"]
CMD ["--log", "fixtures/sample-game.uci", "--port", "16066", "--bind", "0.0.0.0", "--white", "Alpha", "--black", "Beta", "--site", "DockerTest"]
