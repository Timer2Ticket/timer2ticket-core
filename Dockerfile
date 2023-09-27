FROM node:16-alpine as builder

COPY . /app/
WORKDIR /app

RUN npm install && npm run build

FROM node:16-alpine

ENV NODE_ENV=production

USER node

COPY --from=builder --chown=node:node /app/dist /app/dist
COPY --chown=node:node package*.json /app/
WORKDIR /app

RUN npm install --production

CMD [ "node", "./dist/app.js" ]
