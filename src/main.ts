/// <reference types="@songloft/plugin-sdk" />
import { jsonResponse, createRouter, HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';

const router = createRouter();

// 缓存 static/silence.mp3 字节流，避免每次重复读盘解码
let cachedSilenceBytes: Uint8Array | null = null;
// 记录上一次的停止播放定时器，防止连续发送时误停新语音
let stopPlayTimer: any = null;

function getReqBodyText(body: any): string {
    if (!body) return "";
    if (typeof body === 'string') return body;
    try {
        return new TextDecoder().decode(body);
    } catch (e) {
        return "";
    }
}

function base64ToBytes(b64: string): Uint8Array {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const lookup = new Uint8Array(256);
    for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;

    const clean = b64.replace(/[\r\n\s]/g, '');
    let bufferLength = Math.floor(clean.length * 0.75);
    if (clean[clean.length - 1] === '=') bufferLength--;
    if (clean[clean.length - 2] === '=') bufferLength--;

    const bytes = new Uint8Array(bufferLength);
    let p = 0;
    for (let i = 0; i < clean.length; i += 4) {
        const e1 = lookup[clean.charCodeAt(i)];
        const e2 = lookup[clean.charCodeAt(i + 1)];
        const e3 = lookup[clean.charCodeAt(i + 2)];
        const e4 = lookup[clean.charCodeAt(i + 3)];

        bytes[p++] = (e1 << 2) | (e2 >> 4);
        if (p < bufferLength) bytes[p++] = ((e2 & 15) << 4) | (e3 >> 2);
        if (p < bufferLength) bytes[p++] = ((e3 & 3) << 6) | (e4 & 63);
    }
    return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const chunks: string[] = [];
    let chunk = '';
    const len = bytes.byteLength;

    for (let i = 0; i < len; i += 3) {
        const b1 = bytes[i];
        const b2 = i + 1 < len ? bytes[i + 1] : 0;
        const b3 = i + 2 < len ? bytes[i + 2] : 0;

        chunk += chars[b1 >> 2];
        chunk += chars[((b1 & 3) << 4) | (b2 >> 4)];
        chunk += i + 1 < len ? chars[((b2 & 15) << 2) | (b3 >> 6)] : '=';
        chunk += i + 2 < len ? chars[b3 & 63] : '=';

        if (chunk.length >= 8192) {
            chunks.push(chunk);
            chunk = '';
        }
    }
    if (chunk) chunks.push(chunk);
    return chunks.join('');
}

async function getSilenceBytes(): Promise<Uint8Array | null> {
    if (cachedSilenceBytes) return cachedSilenceBytes;
    try {
        const raw: any = await songloft.fs.readFile('static/silence.93ffae12.mp3', { encoding: 'base64' });
        cachedSilenceBytes = typeof raw === 'string' ? base64ToBytes(raw) : new Uint8Array(raw);
        return cachedSilenceBytes;
    } catch (e) {
        songloft.log.warn("读取 static/silence.mp3 失败，将跳过静音拼接: " + e);
        return null;
    }
}

router.post('/upload', async (req) => {
    try {
        const bodyText = getReqBodyText(req.body);
        if (!bodyText) return jsonResponse({ error: '请求体为空' }, 400);

        const data = JSON.parse(bodyText);
        const base64Str = data.audio_base64;
        const accountId = data.account_id;
        const deviceId = data.device_id;
        const durationMs = data.duration_ms || 3000;

        if (!base64Str) return jsonResponse({ error: '未找到 audio_base64 字段' }, 400);

        // 1. 自动识别 iPhone (MP4/AAC) 与 PC/Android (WebM/Opus) 容器并落盘
        const isMp4 = base64Str.slice(4, 12).includes('ZnR5c');
        const rawFile = isMp4 ? 'voice_raw.m4a' : 'voice_raw.webm';
        await songloft.fs.writeFile(rawFile, base64Str, { encoding: 'base64' });

        // 2. 单次转码为与 silence.mp3 完全同规格的无头 MP3 帧流（44100Hz 单声道 128k，禁用 Xing 时长头）
        const execRes: any = await songloft.command.exec('ffmpeg', [
            '-y',
            '-i', rawFile,
            '-vn',
            '-c:a', 'libmp3lame',
            '-ar', '44100',
            '-ac', '1',
            '-b:a', '128k',
            '-write_xing', '0',
            '-id3v2_version', '0',
            '-map_metadata', '-1',
            'voice_body.mp3'
        ]);

        if ((execRes?.exitCode ?? 0) !== 0) {
            throw new Error('ffmpeg 转码失败');
        }

        // 3. 在内存中将录音 MP3 与 3 秒静音 MP3 极速拼接并输出到 static/voice.mp3
        const rawBodyMp3: any = await songloft.fs.readFile('voice_body.mp3', { encoding: 'base64' });
        const bodyBytes = typeof rawBodyMp3 === 'string' ? base64ToBytes(rawBodyMp3) : new Uint8Array(rawBodyMp3);
        const silenceBytes = await getSilenceBytes();

        if (silenceBytes && silenceBytes.byteLength > 0) {
            const merged = new Uint8Array(bodyBytes.byteLength + silenceBytes.byteLength);
            merged.set(bodyBytes, 0);
            merged.set(silenceBytes, bodyBytes.byteLength);
            await songloft.fs.writeFile('static/voice.mp3', bytesToBase64(merged), { encoding: 'base64' });
        } else {
            // 若未读取到静音文件，直接使用原音兜底
            await songloft.fs.writeFile('static/voice.mp3', bytesToBase64(bodyBytes), { encoding: 'base64' });
        }

        const hostUrl = await songloft.plugin.getHostUrl();
        const clientOrigin = data.origin || hostUrl;
        const mp3Url = `${clientOrigin}/api/v1/jsplugin/remote-caller/static/voice.mp3?t=${Date.now()}`;

        if (!accountId || !deviceId) {
            return jsonResponse({ success: true, url: mp3Url });
        }

        // 4. 触发小爱音箱播放
        const token = await songloft.plugin.getToken();
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        };

        await fetch(`${hostUrl}/api/v1/jsplugin/miot/mina/play-url`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                account_id: accountId,
                device_id: deviceId,
                url: mp3Url
            })
        });

        // 5. 定时发送停止指令（配合末尾 3 秒静音缓冲，彻底防止单曲循环）
        if (stopPlayTimer) {
            clearTimeout(stopPlayTimer);
        }
        stopPlayTimer = setTimeout(async () => {
            stopPlayTimer = null;
            try {
                await fetch(`${hostUrl}/api/v1/jsplugin/miot/player/stop`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        account_id: accountId,
                        device_id: deviceId
                    })
                });
            } catch (err) {
                songloft.log.error("停止小爱音箱循环播放失败: " + err);
            }
        }, durationMs + 1500);

        return jsonResponse({ success: true });

    } catch (e: any) {
        songloft.log.error("转码处理失败: " + e.toString());
        return jsonResponse({ success: false, error: e.toString() }, 500);
    }
});

// ===== PWA：Service Worker 由后端路由提供（作用域 = 整个插件入口）=====
// 由插件后端在 /sw.js 返回，作用域才是整个 /api/v1/jsplugin/remote-caller/
const SW_SOURCE = `
const CACHE = 'remote-caller-v1';
const BASE = '/api/v1/jsplugin/remote-caller/';
const SHELL = [BASE, BASE + 'static/manifest.json', BASE + 'static/icons/icon-192.png', BASE + 'static/icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;
  const isShell = p === BASE || p.startsWith(BASE + 'static') || p.startsWith('/api/v1/jsplugin-assets/');
  if (!isShell || p.includes('voice.mp3') || p.includes('/files/')) return;   // 接口、录音一律直连
  const key = url.origin + p;                                                 // 忽略 ?access_token 等查询参数
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)); }
    return res;
  }).catch(() => caches.match(key).then(r => r || Response.error())));        // 网络优先，离线回退缓存
});
`;

router.get('/sw.js', () => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Service-Worker-Allowed': '/api/v1/jsplugin/remote-caller/',
    'Cache-Control': 'no-cache',
  },
  body: SW_SOURCE,
}));

function onInit(): void { songloft.log.info('remote-caller initialized'); }
function onDeinit(): void { songloft.log.info('remote-caller deinitialized'); }
function onHTTPRequest(req: HTTPRequest): HTTPResponse | Promise<HTTPResponse> { return router.handle(req); }

// @ts-expect-error
globalThis.onInit = onInit;
// @ts-expect-error
globalThis.onDeinit = onDeinit;
// @ts-expect-error
globalThis.onHTTPRequest = onHTTPRequest;