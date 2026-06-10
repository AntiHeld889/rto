FROM node:22-alpine

RUN apk add --no-cache --repository=https://dl-cdn.alpinelinux.org/alpine/v3.20/main dhclient
ENV NODE_ENV=production
WORKDIR /app

COPY ["package.json", "package-lock.json*", "./"]
RUN npm ci --omit=dev --silent

COPY . .

CMD ["node", "main.js", "/onvif.yaml"]
