FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 8741
CMD ["npm", "start"]
