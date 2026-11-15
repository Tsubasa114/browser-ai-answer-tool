// 本地控制台：一个极简 HTTP 服务 + 单页界面，用来点点鼠标答题
//   node app/server.js --open        # 启动并自动打开界面
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Controller } from './controller.js';
import { onLog, info, warn, error } from '../src/log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

const args = process.argv.slice(2);
const opt = { port: 3210, open: false, mock: false, config: 'config.json' };
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--port') opt.port = Number(args[++i]) || 3210;
  else if (args[i] === '--open') opt.open = true;
  else if (args[i] === '--mock') opt.mock = true;
  else if (args[i] === '--config') opt.config = args[++i];
}

const controller = new Controller({
  configPath: path.resolve(ROOT, opt.config),
  mock: opt.mock,
  fixtures: path.resolve(ROOT, 'test/fixtures/answers.json'),
});

const UI = fs.readFileSync(path.join(HERE, 'ui.html'), 'utf8');
const logBuffer = [];
const sseClients = new Set();

onLog((ev) => {
  logBuffer.push(ev);
  if (logBuffer.length > 400) logBuffer.shift();
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch (e) {} }
});

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
  });
}

function readHistory(limit = 30) {
  const file = path.resolve(ROOT, controller.cfg.agent.recordFile || 'runs/answers.jsonl');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).reverse().map((l) => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === 'GET /' || route === 'GET /index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(UI);
      return;
    }
    if (route === 'GET /favicon.ico') { res.writeHead(204); res.end(); return; }
    if (route === 'GET /api/ping') { json(res, 200, { ok: true, app: 'browser-autoanswer', mock: opt.mock }); return; }
    if (route === 'GET /api/state') { json(res, 200, controller.snapshot()); return; }
    if (route === 'GET /api/config') { json(res, 200, controller.publicConfig()); return; }
    if (route === 'GET /api/history') {
      json(res, 200, { items: readHistory(Number(url.searchParams.get('limit')) || 30) });
      return;
    }
    if (route === 'GET /api/logs') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      for (const ev of logBuffer.slice(-200)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      sseClients.add(res);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
      req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
      return;
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (route === 'POST /api/connect') { json(res, 200, await controller.connect()); return; }
      if (route === 'POST /api/scan') { json(res, 200, await controller.scan()); return; }
      if (route === 'POST /api/start') { json(res, 200, await controller.start(body)); return; }
      if (route === 'POST /api/stop') { json(res, 200, controller.stop()); return; }
      if (route === 'POST /api/config') {
        try { json(res, 200, { ok: true, config: controller.saveConfig(body) }); }
        catch (e) { json(res, 400, { ok: false, error: e.message }); }
        return;
      }
      if (route === 'POST /api/disconnect') { await controller.disconnect(); json(res, 200, { ok: true }); return; }
      if (route === 'POST /api/shutdown') {
        json(res, 200, { ok: true });
        info('面板已关闭');
        setTimeout(() => process.exit(0), 150);
        return;
      }
    }

    json(res, 404, { ok: false, error: `未知接口 ${route}` });
  } catch (e) {
    error(`接口出错 ${route}: ${e.message}`);
    json(res, 500, { ok: false, error: e.message });
  }
});

function openUrl(u) {
  try {
    const child = spawn('cmd', ['/c', 'start', '', u], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    warn(`自动打开浏览器失败，请手动访问 ${u}`);
  }
}

async function portInUse(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch (e) {
    return false;
  }
}

async function listenFrom(startPort, tries = 20) {
  for (let p = startPort; p < startPort + tries; p += 1) {
    if (await portInUse(p)) {
      if (p === startPort) return { port: p, existing: true };
      continue;
    }
    try {
      await new Promise((resolve, reject) => {
        const onError = (e) => { server.removeListener('listening', onListen); reject(e); };
        const onListen = () => { server.removeListener('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListen);
        server.listen(p, '127.0.0.1');
      });
      return { port: p, existing: false };
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error('找不到可用端口');
}

const { port, existing } = await listenFrom(opt.port);
const url = `http://127.0.0.1:${port}/`;
// AA_NO_OPEN=1 时不自动开浏览器（CI / 自测用）
const noOpen = ['1', 'true'].includes(String(process.env.AA_NO_OPEN || '').toLowerCase());

if (existing) {
  info(`面板已在运行：${url}`);
  if (opt.open && !noOpen) openUrl(url + '?auto=1');
  process.exit(0);
}

info(`面板已启动：${url}`);
info('关闭这个窗口即可停止服务');
if (opt.open && !noOpen) openUrl(url + '?auto=1');
