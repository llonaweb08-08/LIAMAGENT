"""Provider configuration.

Secrets are never stored here. They are read from environment variables first,
then from the local (git-ignored) liam_secrets.py file.
"""

import os


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
UNO_MODELS = [
    "deepseek-chat-v3",
    "deepseek-reasoner",
    "gpt-4o",
    "gpt-4.1",
    "claude-sonnet-4-5",
    "claude-opus-4-5",
    "llama-4-maverick",
    "llama-4-scout",
    "mixtral-8x22b",
    "mistral-large-latest",
    "grok-3-latest",
    "grok-2-latest",
    "command-r-plus",
    "command-r",
    "gpt-4.1-nano",
    "gpt-4.1-mini",
    "o3-mini",
    "o4-mini",
    "deepseek-v4-flash",
    "deepseek-v4-pro",
]

# --- Agnes 3 Flash (free, always available) ---
AGNES_BASE = os.environ.get("AGNES_BASE", "https://apihub.agnes-ai.com/v1")
AGNES_MODEL = os.environ.get("AGNES_MODEL", "agnes-3.0-flash")
AGNES_KEY = str(_secret("AGNES_KEY", "")).strip()

# --- Hugging Face (uncensored, for "bad" things) ---
HF_BASE = os.environ.get("HF_BASE", "https://router.huggingface.co/v1")
HF_MODEL = os.environ.get("HF_MODEL", "nicoboss/Qwen3-32B-Uncensored")
HF_MODEL_8B = os.environ.get("HF_MODEL_8B", "Qwen/Qwen3-8B")
HF_KEY = str(_secret("HF_KEY", "")).strip()

# --- Google Gemini (optional: image generation + voice notes) ---
GOOGLE_API_KEY = str(_secret("GOOGLE_API_KEY", "")).strip()
GOOGLE_IMAGE_MODEL = os.environ.get("LIAM_IMAGE_MODEL", "gemini-2.5-flash-image-preview")
GOOGLE_TTS_MODEL = os.environ.get("LIAM_TTS_MODEL", "gemini-2.5-flash-preview-tts")
