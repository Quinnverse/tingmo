# 听墨 · 后端 TTS 部署指南（腾讯云轻量服务器）

目标：让**不支持 `speechSynthesis` 的浏览器**（vivo 浏览器、夸克、微信 WebView 等）也能听。
前端以 `<audio>` 播放本服务返回的 mp3，因此任何浏览器都可用；且前端仍留在 GitHub Pages（HTTPS），
所以麦克风录音（录背）功能不受影响。

## 一、架构
```
手机浏览器（vivo/夸克等）
   │  fetch 音频
   ▼
https://你的子域名:8443/tts?text=...&rate=1   ← 腾讯云 124.223.15.11，HTTPS，自定义端口
   │
   ▼
tts_server.py（FastAPI + edge-tts）→ 返回 mp3
```

## 二、为什么用自定义端口 8443 + DNS 验证证书
- 腾讯云**大陆服务器**对 80/443 的域名访问强制要求 **ICP 备案**。
- 但**自定义端口（如 8443）不要求备案**，可正常对外。
- 证书用 **Let's Encrypt + DNS-01 验证**（不需要 80 端口），适合未备案域名。
- 前端在 GitHub Pages（HTTPS）fetch 一个 **HTTPS** 地址，不会触发「混合内容」拦截。

## 三、步骤
### 1. 域名解析
把你的一个子域名（如 `tts.你的域名.com`）A 记录指向 `124.223.15.11`。

### 2. 登录服务器，准备环境
```bash
ssh root@124.223.15.11
python3 --version        # 需 3.8+
# 若没有 pip：apt install python3-pip 或 dnf install python3-pip
```

### 3. 放代码
```bash
mkdir -p /opt/tingmo && cd /opt/tingmo
# 把仓库里 server/ 目录内容拷到 /opt/tingmo/server
# （可直接 git clone 整个 tingmo 仓库，再 cd tingmo/server）
```

### 4. 申请证书（DNS-01，以 acme.sh 为例）
```bash
curl https://get.acme.sh | sh
# 以你的 DNS 服务商为例（腾讯云 DNSPod / 阿里云 DNS）：
export DP_Id="你的DNSPod ID"; export DP_Key="你的DNSPod Token"
~/.acme.sh/acme.sh --issue --dns dns_dp -d tts.你的域名.com
# 证书导出到 /etc/tingmo
mkdir -p /etc/tingmo
~/.acme.sh/acme.sh --installcert -d tts.你的域名.com \
  --key-file /etc/tingmo/key.pem \
  --fullchain-file /etc/tingmo/cert.pem
```
> 其他 DNS 服务商（阿里云、Cloudflare 等）用对应 `dns_xxx` 插件即可，见 acme.sh 文档。

### 5. 配置并启动
```bash
cd /opt/tingmo/server
chmod +x run.sh
# 方式 A：systemd（推荐，开机自启）
cp tingmo-tts.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tingmo-tts

# 方式 B：临时前台 / nohup
# nohup ./run.sh > /tmp/tingmo-tts.log 2>&1 &
```

### 6. 开放端口
在**腾讯云控制台 → 防火墙/安全组**放行 **TCP 8443**（入站）。

### 7. 自测
```bash
curl -k https://localhost:8443/health
curl -k "https://localhost:8443/tts?text=你好世界&rate=1" -o /tmp/t.mp3 && file /tmp/t.mp3
```
若 `tts` 返回的是 mp3 且 `file` 识别为 MPEG，说明通了。

### 8. 前端指向该服务
编辑 `tingmo/app.js`，把
```js
const TTS_ENDPOINT = '';
```
改为
```js
const TTS_ENDPOINT = 'https://tts.你的域名.com:8443/tts';
```
然后 `git add -A && git commit && git push`（GitHub Pages 会自动更新）。

## 四、国内访问微软接口被墙的兜底
`edge-tts` 走微软服务器。若服务器在大陆连不上微软（自测第 7 步 `tts` 返回 502），
改用**阿里云百炼 TTS**（用户已有 API Key，国内可达）：
1. `pip install dashscope`
2. 在 `tts_server.py` 增加 `engine=dashscope` 分支（用 CosyVoice 模型，返回音频 URL 再回传）。
3. 设环境变量 `DASHSCOPE_API_KEY=...` 与 `TTS_ENGINE=dashscope`。
> 该分支在部署时按官方最新文档实现（避免写出过时签名）。

## 五、排错
- 前端报「音频加载失败」：先看服务器 `journalctl -u tingmo-tts` 日志；多为证书路径错 / 端口未放行 / 微软接口不通。
- 浏览器报证书错误：确认证书是用**你解析的那个域名**申请的，且未过期。
- 混合内容拦截：确认前端 TTS_ENDPOINT 是 **https://** 开头（不是 http）。
