FROM node:18-bullseye

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies required by Electron.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    dumb-init \
    git \
    libasound2 \
    libglib2.0-0 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libdrm2 \
    libgbm1 \
    libgl1 \
    libglu1-mesa \
    libgtk-3-0 \
    libnotify4 \
    libnss3 \
    libpci3 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxshmfence1 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxtst6 \
    mesa-utils \
    wget \
    xvfb \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install npm dependencies separately to leverage Docker layer caching.
COPY package.json package-lock.json* ./
RUN npm install \
 && touch node_modules/.modules-built \
 && npm cache clean --force

# Copy the rest of the application.
COPY . .

# Ensure the entrypoint is executable.
RUN chmod +x docker-entrypoint.sh

ENV ELECTRON_ENABLE_LOGGING=1 \
    NODE_ENV=development

ENTRYPOINT ["dumb-init", "--", "./docker-entrypoint.sh"]
CMD ["npm", "run", "dev"]
