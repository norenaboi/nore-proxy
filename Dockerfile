FROM node:26-slim AS build
WORKDIR /app
COPY package*.json ./
# better-sqlite3 13 ships prebuilt binaries in prebuilds/ (glibc and musl),
# so install scripts aren't needed — and node:26-slim has no python3/make/g++
# for node-gyp, which npm would otherwise invoke via binding.gyp.
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build:frontend

FROM node:26-slim AS runtime
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
COPY --from=build /app/dist/frontend ./dist/frontend
EXPOSE 8741
CMD ["npm", "start"]
