# Liam runs one Node process (WhatsApp bridge) plus one Python process (agent)
# in the same small container. Render free gives us 512 MB RAM, so avoid
# unnecessary build layers and never install the dev/test toolchain here.
#
# Python is pinned to 3.12 everywhere (see .python-version / pyproject.toml).
# Debian bookworm ships 3.11, so start from the official Python 3.12 slim image
# and add Node 20 from NodeSource instead of using apt's older interpreter.
FROM python:3.12-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    NODE_ENV=production \
    HOME=/home/liam \
    LIAM_DATA_DIR=/data \
    LIAM_DB=/data/liam_memory.db \
    LIAM_PYTHON=/opt/venv/bin/python \
    PORT=5678 \
    PLAYWRIGHT_BROWSERS_PATH=/home/liam/.cache/ms-playwright

# sqlite3 gives the bridge a WAL-safe snapshot tool, and ffmpeg converts the
# voice to OGG/Opus (edge-tts returns MP3). curl is used by the HEALTHCHECK.
# The official Python image already provides ensurepip, so python3-pip and
# python3-venv are not needed. libatomic1 is required by the Playwright chromium
# driver (libatomic.so.1); --with-deps does not always pull it in on slim images.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl ffmpeg gzip sqlite3 tar libatomic1 \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --home-dir /home/liam --shell /usr/sbin/nologin liam \
    && mkdir -p /app /data /home/liam/.cache \
    && chown -R liam:liam /app /data /home/liam

WORKDIR /app

# Node dependencies first so a source-only change keeps this layer cached.
# Baileys is pure JavaScript, so no browser download happens here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Python dependencies in a venv so the image's Python is left untouched.
# Playwright's Chromium is only used by the screenshot/browser tools.
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

# EXPOSE is informational. Render injects PORT=10000 at runtime and the bridge
# binds that value; 5678 is only the default for local `docker run` use.
EXPOSE 5678
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-5678}/health" >/dev/null || exit 1
CMD ["npm", "start"]
