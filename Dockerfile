# Revora Backend Dockerfile
# Multi-stage build for optimized production image

# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src ./src

# Build TypeScript to JavaScript
RUN npm run build

# Stage 2: Production
FROM node:22-alpine

WORKDIR /app

# Install curl for health checks
RUN apk add --no-cache curl

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Run the application as the unprivileged node user.
RUN chown -R node:node /app
USER node

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose application port
EXPOSE 3000

# Configure Docker health check
# - Uses GET /health endpoint as specified in requirements 7.1
# - Timeout: 5 seconds (requirement 7.4)
# - Retries: 3 attempts before marking unhealthy (requirement 7.5)
# - Interval: 30 seconds between checks (requirement 7.1)
# - HTTP 200 = healthy, HTTP 503 = unhealthy (requirements 7.2, 7.3)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the application
CMD ["node", "dist/index.js"]
