"""
听墨 · 后端 TTS 服务
- 默认用 edge-tts（免费、无需 key）合成中文语音，返回 mp3 音频。
- 前端以 <audio> 播放，因此任何浏览器（含 vivo/夸克/微信 WebView）都能听。
- 部署：见同目录 DEPLOY.md。证书用 Let's Encrypt（DNS-01 验证，无需 80 端口，绕开备案）。

⚠️ 国内注意：edge-tts 走微软接口，若服务器在大陆无法连通微软，
   部署时请改用「阿里云百炼 TTS」分支（见 DEPLOY.md，用户已有 API Key）。
"""
import os
import asyncio
from fastapi import FastAPI, Query
from fastapi.responses import Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import edge_tts

app = FastAPI(title="Tingmo TTS")

# 允许的前端源（GitHub Pages 域名）
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "https://quinnverse.github.io").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)

VOICE = os.getenv("TTS_VOICE", "zh-CN-XiaoxiaoNeural")


@app.get("/health")
def health():
    return {"ok": True, "engine": "edge-tts", "voice": VOICE}


@app.get("/tts")
async def tts(text: str = Query(..., min_length=1, max_length=2000), rate: float = 1.0):
    rate = max(0.5, min(2.0, rate))
    pct = int(round((rate - 1) * 100))
    rate_str = f"{'+' if pct >= 0 else ''}{pct}%"
    try:
        comm = edge_tts.Communicate(text, VOICE, rate=rate_str)
        audio = b""
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                audio += chunk["data"]
    except Exception as e:  # 微软接口不通等
        return JSONResponse(status_code=502, content={"error": str(e)})
    if not audio:
        return JSONResponse(status_code=502, content={"error": "empty audio"})
    return Response(
        content=audio,
        media_type="audio/mpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "tts_server:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8443")),
        ssl_keyfile=os.getenv("SSL_KEYFILE"),
        ssl_certfile=os.getenv("SSL_CERTFILE"),
    )
