FROM node:18-slim

# Without this, all outbound HTTPS from the container fails at runtime with
# UNABLE_TO_GET_ISSUER_CERT_LOCALLY — node:18-slim ships no root CA bundle.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g maritime-cli

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY desired-state.json ./
COPY src ./src

ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/index.js"]
