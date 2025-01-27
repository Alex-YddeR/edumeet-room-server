FROM node:18-bullseye-slim

WORKDIR /usr/src/app

COPY . .

# Lets make sure we have a valid config before we build
RUN cp config/config.example.json config/config.json

RUN yarn install
RUN yarn run build

EXPOSE ${8443}

ENTRYPOINT DEBUG=edumeet:* yarn run prodstart $0 $@
