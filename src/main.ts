/// <reference types="@songloft/plugin-sdk" />
import { jsonResponse, createRouter, HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk';

const router = createRouter();

// 极简且精准的 Body 解析
function getReqBodyText(body: any): string {
    if (!body) return "";
    // 已经探明底层直接传递了字符串
    if (typeof body === 'string') return body;
    try {
        return new TextDecoder().decode(body);
    } catch (e) {
        return "";
    }
}

router.post('/upload', async (req) => {
    try {
        const bodyText = getReqBodyText(req.body);
        if (!bodyText) return jsonResponse({ error: '请求体为空' }, 400);

        const data = JSON.parse(bodyText);
        const base64Str = data.audio_base64;

        if (!base64Str) return jsonResponse({ error: '未找到 audio_base64 字段' }, 400);

        // 1. 用 SDK 原生能力解码 Base64 并落盘
        await songloft.fs.writeFile('voice_raw.webm', base64Str, { encoding: 'base64' });

        // 2. 拉起 ffmpeg 压制为 MP3
        await songloft.command.exec('ffmpeg', [
            '-y',
            '-i', 'voice_raw.webm',
            '-c:a', 'libmp3lame',
            '-b:a', '128k',
            'static/voice.mp3'
        ]);

        // 3. 返回真实 MP3 直链给前端
        const hostUrl = await songloft.plugin.getHostUrl();
        return jsonResponse({
            success: true,
            url: `${hostUrl}/api/v1/jsplugin/remote-caller/files/voice.mp3`
        });
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