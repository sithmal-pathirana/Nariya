# Use an official Node runtime as a parent image
# Using alpine for minimal footprint, perfect for free tier constraints
FROM node:20-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY backend/package*.json ./

# Install dependencies exclusively for production
RUN npm ci --only=production

# Bundle app source inside Docker image
COPY backend/ .

# Expose port 8080 (Matches PORT in .env.template)
EXPOSE 8080

# Command to run the application securely (avoiding root privileges where possible)
USER node
CMD [ "npm", "start" ]
