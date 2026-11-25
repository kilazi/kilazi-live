FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY bin bin
COPY src src
COPY public public
ENV HOST=0.0.0.0 PORT=4321 NO_OPEN=1 NOTES_DIR=/tmp/kilazi-live-notes
USER node
EXPOSE 4321
CMD ["node", "bin/kilazi-live.js"]
