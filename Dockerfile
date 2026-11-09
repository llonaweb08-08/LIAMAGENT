# Liam runs one Node process (WhatsApp bridge) plus one Python process (agent)
# in the same small container. Render free gives us 512 MB RAM, so avoid
# unnecessary build layers and never install the dev/test toolchain here.
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NODE_ENV=production \
    HOME=/home/liam \
    LIAM_DATA_DIR=/data \
    LIAM_DB=/data/liam_memory.db \
    LIAM_PYTHON=/opt/venv/bin/python \
    PORT=5678 \
    PUPPETEER_CACHE_DIR=/home/liam/.cache/puppeteer \
    PLAYWRIGHT_BROWSERS_PATH=/home/liam/.cache/ms-playwright

# python3 is Debian's Python 3.11; sqlite3 gives the bridge a WAL-safe snapshot
# tool, and ffmpeg converts Liam's WAV replies to WhatsApp voice notes.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl ffmpeg gzip python3 python3-pip python3-venv \
        sqlite3 tar \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --home-dir /home/liam --shell /usr/sbin/nologin liam \
    && mkdir -p /app /data /home/liam/.cache \
    && chown -R liam:liam /app /data /home/liam

WORKDIR /app

# Node dependencies first so a source-only change keeps this layer cached.
# npm ci runs Puppeteer's install script, which downloads WhatsApp Web's
# Chromium into the persistent cache directory above.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Python dependencies in a venv so Debian's externally-managed Python is left
# untouched. Playwright's Chromium is only used by the screenshot/browser tools.
COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt \
    && /opt/venv/bin/python -m playwright install --with-deps chromium

COPY . .

# Runtime user cannot write to the image root, but it owns the writable data
# directory, the app tree (tools/ is written at runtime), and browser caches.
RUN chown -R liam:liam /app /data /home/liam

USER liam

EXPOSE 5678
CMD ["npm", "start"]
