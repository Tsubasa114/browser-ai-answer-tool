// 面板端到端自测：起一个带题目页的浏览器 + 面板服务（演示模式），
// 走 HTTP 接口完成 扫描 → 预览 → 正式答题 → 校验结果 → 关闭。
//   node test/panel-e2e.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchDebugBrowser, waitCdp, findExecutable } from '../src/browser.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3300 + Math.floor(Math.random() * 120);
const CDP_PORT = 9300 + Math.floor(Math.random() * 120);
const ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
const QUIZ = 'file:///' + path.join(ROOT, 'test', 'mock-quiz.html').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const cfgPath = path.join(os.tmpdir(), `aa-panel-${Date.now()}.json`);
fs.writeFileSync(cfgPath, JSON.stringify({
  browser: { cdpEndpoint: ENDPOINT, autoLaunch: false },
  agent: {
    delayMs: 60,
    waitChangeMs: 6000,
    recordFile: path.join(os.tmpdir(), `aa-panel-answers-${Date.now()}.jsonl`),
  },
}), 'utf8');

async function api(p, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`等待超时：${label}`);
}

async function waitDone() {
  return waitFor(async () => {
    const s = await api('/api/state');
    if (s.status === 'done' || s.status === 'error') return s;
    return null;
  }, 90000, '本轮结束');
}

if (!findExecutable({ browser: { channel: 'msedge', executablePath: '' } })) {
  console.error('没找到 Edge/Chrome，无法跑面板测试');
  process.exit(1);
}

const edge = launchDebugBrowser({
  browser: {
    channel: 'msedge', executablePath: '', debugPort: CDP_PORT, cdpEndpoint: ENDPOINT,
    headless: true, url: QUIZ, userDataDir: path.join(os.tmpdir(), `aa-panel-edge-${Date.now()}`),
  },
});
const server = spawn(process.execPath, ['app/server.js', '--mock', '--port', String(PORT), '--config', cfgPath], {
  cwd: ROOT, stdio: 'ignore',
});

try {
  await waitCdp(ENDPOINT, 60000);
  const ping = await waitFor(async () => (await api('/api/ping')).ok, 30000, '面板启动');
  check('面板服务启动', !!ping);

  const scan = await api('/api/scan', {});
  check('扫描找到题目页', !!scan.ok && !!scan.tab && scan.tab.url.includes('mock-quiz'), scan.tab ? `${scan.tab.title} 得分=${scan.tab.score}` : scan.error);

  const start1 = await api('/api/start', { dryRun: true });
  check('启动预览模式', !!start1.ok, start1.error || '');
  const done1 = await waitDone();
  check('预览跑完全部题目', done1.total >= 8 || (done1.result && done1.result.total === 8), `total=${done1.result ? done1.result.total : '?'} reason=${done1.result ? done1.result.reason : ''}`);
  check('预览不提交', done1.result && done1.result.submitted === false);

  const start2 = await api('/api/start', { url: QUIZ, dryRun: false, autoSubmit: true });
  check('启动正式答题', !!start2.ok, start2.error || '');
  const done2 = await waitDone();
  check('正式答题全部成功', done2.result && done2.result.ok === 8, `ok=${done2.result ? done2.result.ok : '?'} total=${done2.result ? done2.result.total : '?'}`);
  check('结果页 100 分', !!(done2.result && /100/.test(done2.result.score)), done2.result ? done2.result.score.replace(/\s+/g, ' ').slice(0, 40) : '');
  check('状态回到 done', done2.status === 'done');

  const hist = await api('/api/history?limit=10');
  check('答题记录可查', Array.isArray(hist.items) && hist.items.length >= 8, `${hist.items ? hist.items.length : 0} 条`);

  const cfg = await api('/api/config');
  check('配置接口可用', !!cfg.llm && !!cfg.agent && cfg.mock === true);
} catch (e) {
  check('测试执行', false, e.message);
} finally {
  await api('/api/shutdown', {}).catch(() => {});
  try { edge.kill(); } catch (e) {}
  try { server.kill(); } catch (e) {}
  await sleep(300);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) process.exitCode = 1;
