#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

# 虚拟环境
if [ ! -d venv ]; then python3 -m venv venv; fi
# shellcheck disable=SC1091
source venv/bin/activate
pip install -r requirements.txt -q

export ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://quinnverse.github.io}"
export TTS_VOICE="${TTS_VOICE:-zh-CN-XiaoxiaoNeural}"
export PORT="${PORT:-8443}"
export SSL_KEYFILE="${SSL_KEYFILE:-/etc/tingmo/key.pem}"
export SSL_CERTFILE="${SSL_CERTFILE:-/etc/tingmo/cert.pem}"

exec uvicorn tts_server:app --host 0.0.0.0 --port "$PORT" \
  --ssl-keyfile "$SSL_KEYFILE" --ssl-certfile "$SSL_CERTFILE"
