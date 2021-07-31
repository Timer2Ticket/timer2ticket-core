FROM node:14-alpine

ENV NODE_ENV=production

USER node

COPY --chown=node:node . /app/
WORKDIR /app

RUN npm install --production && npm run build

CMD [ "node", "./dist/app.js" ]
