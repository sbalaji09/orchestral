FROM node:18-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g maritime-cli

CMD ["sh", "-c", "maritime list --json"]
