FROM node:20-slim

# System deps for Playwright/Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt && \
    python3 -m playwright install chromium

COPY . .

ENV LIAM_DATA_DIR=/data
ENV LIAM_DB=/data/liam_memory.db
ENV PORT=5678

EXPOSE 5678
CMD ["npm", "start"]