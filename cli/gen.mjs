#!/usr/bin/env node
/**
 * gen.mjs — 直接调用中转站（guaihub / New API 面板）的图片生成接口。
 *
 * 背景：DSH 的模型走的是 anthropic-messages 聊天协议，图片模型不是聊天模型，
 * 所以把 gpt-image-2.5-flare 当聊天模型选进去是出不了图的。
 * 中转站（New API 面板）本身提供 OpenAI 风格的 POST /v1/images/generations，
 * 这个脚本直接打那个接口，跟 Studio 用的是同一套后端。
 *
 * 用法：
 *   node gen.mjs --prompt "一只赛博朋克猫" --out images/cat.png
 *   node gen.mjs --list                     # 列出中转站可用模型
 *   node gen.mjs --prompt "..." --model gpt-image-2 --size 1024x1536 --n 2
 *   node gen.mjs --prompt "..." --raw       # 打印原始 JSON（调试用）
 *   node gen.mjs --video --model video-ds-2.0 --prompt "..." --out out.mp4
 *   node gen.mjs --edit --image in.png --prompt "把背景换成海边"   # 图生图
 *
 * 环境变量：
 *   GUAIHUB_API_KEY   不设则从 ~/.dsh/.credentials.yaml 的 refs 里读
 *   GUAIHUB_BASE_URL  默认 https://guaihub.com
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = (process.env.GUAIHUB_BASE_URL || 'https://guaihub.com').replace(/\/+$/, '');

/* ---------- 参数解析 ---------- */
const argv = process.argv.slice(2);
const opt = { model: 'gpt-image-2', size: '1024x1024', n: 1, out: null, prompt: null, raw: false, list: false, quality: null, background: null, extra: null, timeout: 300000, video: false, edit: null, poll: 5000, maxWait: 900000 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => argv[++i];
  switch (a) {
    case '--prompt': case '-p': opt.prompt = val(); break;
    case '--model': case '-m': opt.model = val(); break;
    case '--size': case '-s': opt.size = val(); break;
    case '--n': opt.n = Number(val()); break;
    case '--out': case '-o': opt.out = val(); break;
    case '--quality': opt.quality = val(); break;
    case '--background': opt.background = val(); break;
    case '--extra': opt.extra = JSON.parse(val()); break;
    case '--timeout': opt.timeout = Number(val()); break;
    case '--video': opt.video = true; break;
    case '--edit': opt.edit = val(); break;
    case '--poll': opt.poll = Number(val()); break;
    case '--max-wait': opt.maxWait = Number(val()); break;
    case '--raw': opt.raw = true; break;
    case '--list': opt.list = true; break;
    case '--help': case '-h': console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]); process.exit(0);
    default: if (a.startsWith('--')) { console.error(`未知参数: ${a}`); process.exit(2); }
  }
}

/* ---------- 读取密钥 ---------- */
function readKey() {
  if (process.env.GUAIHUB_API_KEY) return process.env.GUAIHUB_API_KEY.trim();
  const credFile = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  if (fs.existsSync(credFile)) {
    const m = fs.readFileSync(credFile, 'utf8').match(/^\s*GUAIHUB_API_KEY:\s*(\S+)\s*$/m);
    if (m) return m[1];
  }
  throw new Error('找不到 GUAIHUB_API_KEY（环境变量和 ~/.dsh/.credentials.yaml 都没有）');
}

async function api(pathname, { method = 'POST', body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opt.timeout);
  try {
    const res = await fetch(BASE + pathname, {
      method,
      headers: { Authorization: `Bearer ${readKey()}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || text.slice(0, 500);
      throw new Error(`HTTP ${res.status} ${pathname}: ${msg}`);
    }
    return json ?? text;
  } finally { clearTimeout(timer); }
}

/* ---------- 列表模式 ---------- */
if (opt.list) {
  const data = await api('/v1/models', { method: 'GET' });
  const ids = (data?.data ?? []).map((m) => m.id ?? m).sort();
  console.log(ids.join('\n'));
  console.log(`\n共 ${ids.length} 个模型`);
  process.exit(0);
}

if (!opt.prompt) { console.error('缺少 --prompt。用 --help 看用法。'); process.exit(2); }

/* ---------- 生成 ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asText = (v) => (v == null ? '' : String(v).toLowerCase());
function pickStatus(j) { return asText(j?.status ?? j?.state ?? j?.data?.status ?? j?.data?.state); }
function extractUrl(j) {
  const d = j?.data ?? j;
  const cands = [d?.url, d?.output, d?.video_url, d?.videoUrl, d?.output?.url, d?.data?.url, d?.data?.output, d?.data?.video_url, d?.videos, d?.output?.video_url, j?.url, j?.output];
  for (let c of cands) {
    if (Array.isArray(c)) c = c[0];
    if (c && typeof c === 'object') c = c.url ?? c.video_url ?? c.output;
    if (typeof c === 'string' && /^https?:\/\//.test(c)) return c;
  }
  return null;
}
function extractTaskId(j) { return j?.id ?? j?.task_id ?? j?.data?.task_id ?? j?.data?.id ?? j?.data?.taskId ?? null; }

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}: ${url}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  console.log(`OK  ${file}  (${(fs.statSync(file).size / 1024).toFixed(1)} KB)`);
}

/* ---- 视频：提交任务 + 轮询 ---- */
if (opt.video) {
  const payload = { model: opt.model, prompt: opt.prompt };
  if (opt.size) payload.size = opt.size;
  if (opt.extra) Object.assign(payload, opt.extra);
  if (opt.raw) console.error('请求体: ' + JSON.stringify(payload));

  const sub = await api('/v1/video/generations', { body: payload });
  if (opt.raw) console.log(JSON.stringify(sub, null, 2));
  const taskId = extractTaskId(sub);
  if (!taskId) { console.error('没拿到 task id: ' + JSON.stringify(sub).slice(0, 800)); process.exit(1); }
  console.log(`任务已提交: ${taskId}（轮询中，每 ${opt.poll / 1000}s）`);

  const deadline = Date.now() + opt.maxWait;
  let last = '';
  for (;;) {
    const st = await api(`/v1/video/generations/${encodeURIComponent(taskId)}`, { method: 'GET' });
    const status = pickStatus(st);
    if (status && status !== last) { console.log(`  状态: ${status}`); last = status; }
    const url = extractUrl(st);
    if (url && ['succeeded', 'success', 'completed', 'done', 'finished'].includes(status || 'succeeded')) {
      const out = path.resolve(opt.out || path.join('images', `${taskId}.mp4`));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await download(url, out);
      if (opt.raw) console.log(JSON.stringify(st, null, 2));
      process.exit(0);
    }
    if (['failed', 'failure', 'error', 'canceled', 'cancelled'].includes(status)) {
      console.error('任务失败: ' + JSON.stringify(st).slice(0, 800)); process.exit(1);
    }
    if (Date.now() > deadline) { console.error('超时，任务仍在跑，task id: ' + taskId); process.exit(1); }
    await sleep(opt.poll);
  }
}

/* ---- 图生图 / 编辑（multipart） ---- */
if (opt.edit) {
  const fd = new FormData();
  fd.append('model', opt.model);
  fd.append('prompt', opt.prompt);
  fd.append('image', new Blob([fs.readFileSync(opt.edit)]), path.basename(opt.edit));
  if (opt.size) fd.append('size', opt.size);
  if (opt.extra) for (const [k, v] of Object.entries(opt.extra)) fd.append(k, String(v));
  const res = await fetch(BASE + '/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${readKey()}` },
    body: fd,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) throw new Error(`HTTP ${res.status} /v1/images/edits: ${json?.error?.message || text.slice(0, 400)}`);
  if (opt.raw) { console.log(JSON.stringify(json, null, 2)); process.exit(0); }
  const items = json?.data ?? [];
  if (!items.length) { console.error('没有返回图片: ' + text.slice(0, 600)); process.exit(1); }
  const out = path.resolve(opt.out || path.join('images', `edit-${Date.now()}.png`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const it = items[0];
  if (it.b64_json) fs.writeFileSync(out, Buffer.from(it.b64_json, 'base64'));
  else await download(it.url, out);
  console.log(`OK  ${out}  (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
  process.exit(0);
}

/* ---- 文生图 ---- */
const payload = { model: opt.model, prompt: opt.prompt, n: opt.n, size: opt.size };
if (opt.quality) payload.quality = opt.quality;
if (opt.background) payload.background = opt.background;
if (opt.extra) Object.assign(payload, opt.extra);

if (opt.raw) console.error('请求体: ' + JSON.stringify(payload));

const result = await api('/v1/images/generations', { body: payload });
if (opt.raw) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }

const items = result?.data ?? [];
if (!items.length) { console.error('接口没返回图片: ' + JSON.stringify(result).slice(0, 800)); process.exit(1); }

const outDir = path.resolve(opt.out ? path.dirname(opt.out) : 'images');
fs.mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
for (let i = 0; i < items.length; i++) {
  const it = items[i];
  const base = opt.out
    ? (items.length > 1 ? opt.out.replace(/(\.[a-z0-9]+)$/i, `-${i + 1}$1`) : opt.out)
    : path.join(outDir, `${opt.model.replace(/[^\w.-]/g, '_')}-${stamp}${i ? '-' + (i + 1) : ''}.png`);
  const file = path.resolve(base);
  if (it.b64_json) {
    fs.writeFileSync(file, Buffer.from(it.b64_json, 'base64'));
  } else if (it.url) {
    const r = await fetch(it.url);
    if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}: ${it.url}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  } else {
    console.error('这一项既没有 b64_json 也没有 url: ' + JSON.stringify(it).slice(0, 400));
    continue;
  }
  const kb = (fs.statSync(file).size / 1024).toFixed(1);
  console.log(`OK  ${file}  (${kb} KB)`);
  if (it.revised_prompt) console.log(`revised_prompt: ${it.revised_prompt}`);
}
