FROM node:18-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:frontend

FROM node:18-slim AS runtime
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
COPY --from=build /app/dist/frontend ./dist/frontend
EXPOSE 8741
CMD ["npm", "start"]
