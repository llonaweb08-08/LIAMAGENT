"""Provider configuration.

Secrets are never stored here. They are read from environment variables first,
then from the local (git-ignored) liam_secrets.py file.
"""

import os

# Many free providers sit behind Cloudflare and reject Python's default
# User-Agent. One shared browser UA keeps every provider probe and call equal.
BROWSER_UA = os.environ.get(
    "LIAM_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
)


def _secret(name, default):
    value = os.environ.get(name)
    if value:
        return value
    try:
        import liam_secrets
        value = getattr(liam_secrets, name, None)
        if value:
            return value
    except ImportError:
        pass
    return default


def _keys(name):
    raw = _secret(name, ())
    if isinstance(raw, str):
        raw = raw.replace("\n", ",").split(",")
    return [str(key).strip() for key in raw if str(key).strip()]


# --- MoonMath API keys (rotated when one hits its daily limit) ---
MOON_KEYS = _keys("MOON_KEYS")
MOON_BASE = os.environ.get("MOON_BASE", "https://zro.moonmath.ai/v1")
MOON_MODEL = os.environ.get("MOON_MODEL", "deepseek-v4.1-flash")
MOON_FALLBACK = os.environ.get("MOON_FALLBACK", "glm-5.3-flash")

# --- Unorouter API keys (rotated per request) ---
UNO_KEYS = _keys("UNO_KEYS")
UNO_BASE = os.environ.get("UNO_BASE", "https://api.unorouter.com/v1")
# Free models are rate limited to one request per minute each. Models that
# need a one-time provider consent (gpt-4o:free, qwen3.6-35b-a3b:free) still
# work after visiting https://unorouter.com/consents?model=<model>.
UNO_MODELS = [
    "claude-haiku-4-5-20251001:free", "bielik-11b-v3.0-instruct:free",
    "agnes-3.0-flash:free", "qwen3.6-35b-a3b:free",
    "deepseek-r1-distill-llama-70b:free", "gpt-4o:free",
]

# --- Agnes 3 Flash (free, always available) ---
AGNES_BASE = os.environ.get("AGNES_BASE", "https://apihub.agnes-ai.com/v1")
AGNES_MODEL = os.environ.get("AGNES_MODEL", "agnes-3.0-flash")
AGNES_KEY = str(_secret("AGNES_KEY", "")).strip()

# --- Hugging Face ---
# The public router's Qwen models returned HTTP 400 during verification, so
# Hugging Face is no longer used as a brain. The constants stay for backwards
# compatibility with old local secret files.
HF_BASE = os.environ.get("HF_BASE", "https://router.huggingface.co/v1")
HF_MODEL = os.environ.get("HF_MODEL", "")
HF_MODEL_8B = os.environ.get("HF_MODEL_8B", "")
HF_KEY = str(_secret("HF_KEY", "")).strip()

# --- HCNSec (tool-capable fallback after Agnes) ---
HCN_BASE = os.environ.get("HCN_BASE", "https://api.hcnsec.cn/v1")
HCN_MODEL = os.environ.get("HCN_MODEL", "auto")
HCN_KEY = str(_secret("HCN_KEY", "")).strip()

# --- Search providers (first configured one wins) ---
TAVILY_API_KEY = str(_secret("TAVILY_API_KEY", "")).strip()
BRAVE_API_KEY = str(_secret("BRAVE_API_KEY", "")).strip()
SERPER_API_KEY = str(_secret("SERPER_API_KEY", "")).strip()

GOOGLE_API_KEY = str(_secret("GOOGLE_API_KEY", "")).strip()
GOOGLE_IMAGE_MODEL = os.environ.get("LIAM_IMAGE_MODEL", "gemini-2.5-flash-image-preview")
GOOGLE_TTS_MODEL = os.environ.get("LIAM_TTS_MODEL", "gemini-2.5-flash-preview-tts")
