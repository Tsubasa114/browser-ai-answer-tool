// 生成面板截图（文档/演示用）：起一个演示浏览器 + 面板，跑一轮，然后把界面截下来。
//   node tools/screenshot-panel.js [输出路径]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { launchDebugBrowser, waitCdp, findExecutable } from '../src/browser.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2] || path.join(ROOT, 'runs', 'panel.png');
const PORT = 3400 + Math.floor(Math.random() * 90);
const CDP_PORT = 9500 + Math.floor(Math.random() * 90);
const ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
const QUIZ = 'file:///' + path.join(ROOT, 'test', 'mock-quiz.html').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!findExecutable({ browser: { channel: 'msedge', executablePath: '' } })) {
  console.error('没找到 Edge/Chrome');
  process.exit(1);
}

const cfgPath = path.join(os.tmpdir(), `aa-shot-${Date.now()}.json`);
fs.writeFileSync(cfgPath, JSON.stringify({
  browser: { cdpEndpoint: ENDPOINT, autoLaunch: false },
  agent: { delayMs: 90, recordFile: path.join(os.tmpdir(), `aa-shot-${Date.now()}.jsonl`) },
}), 'utf8');

const api = async (p, body) => (await fetch(`http://127.0.0.1:${PORT}${p}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})).json();

const edge = launchDebugBrowser({
  browser: {
    channel: 'msedge', executablePath: '', debugPort: CDP_PORT, cdpEndpoint: ENDPOINT,
    headless: true, url: QUIZ, userDataDir: path.join(os.tmpdir(), `aa-shot-edge-${Date.now()}`),
  },
});
const server = spawn(process.execPath, ['app/server.js', '--mock', '--port', String(PORT), '--config', cfgPath], { cwd: ROOT, stdio: 'ignore' });

try {
  await waitCdp(ENDPOINT, 60000);
  for (let i = 0; i < 40; i += 1) {
    if ((await api('/api/ping').catch(() => ({}))).ok) break;
    await sleep(300);
  }
  await api('/api/scan', {});
  await api('/api/start', { dryRun: false, autoSubmit: true });
  for (let i = 0; i < 120; i += 1) {
    const s = await api('/api/state');
    if (s.status === 'done') break;
    await sleep(400);
  }

  const browser = await chromium.connectOverCDP(ENDPOINT, { timeout: 20000 });
  const page = await browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 1280, height: 940 });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  await page.screenshot({ path: OUT });
  console.log('screenshot saved:', OUT);
  try { await browser.close(); } catch (e) {}
} catch (e) {
  console.error('截图失败:', e.message);
  process.exitCode = 1;
} finally {
  await api('/api/shutdown', {}).catch(() => {});
  try { edge.kill(); } catch (e) {}
  try { server.kill(); } catch (e) {}
}
