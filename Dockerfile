FROM node:23-alpine

WORKDIR /app

# Install dependencies (production only, cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Data directory is mounted as a volume at runtime
RUN mkdir -p /app/data

EXPOSE 3233

CMD ["node", "server.js"]
