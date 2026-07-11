FROM node:18-slim

RUN npm install -g maritime-cli

CMD ["sh", "-c", "maritime list --json"]
