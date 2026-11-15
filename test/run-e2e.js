// 端到端自测：本地假页面 + 本地“假模型”接口，跑完整链路（提取 → 作答 → 翻页 → 交卷 → 判分）
// 不联网、不需要 API Key：node test/run-e2e.js
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { loadConfig } from '../src/config.js';
import { makeLlmSolver, parseJSONLoose } from '../src/solver.js';
import { runAgent } from '../src/agent.js';
import { findExecutable, launchDebugBrowser, waitCdp } from '../src/browser.js';
import { detectTarget } from '../src/detect.js';
import { onLog } from '../src/log.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TEST_DIR = path.join(ROOT, 'test');
const FIXTURES = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'fixtures', 'answers.json'), 'utf8'));

function serveStatic() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'mock-quiz.html';
      const file = path.join(TEST_DIR, name);
      if (!file.startsWith(TEST_DIR) || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// 一个 OpenAI 兼容的假模型：从提示词里认出题目，返回答案表里的答案
function serveFakeModel() {
  const calls = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let answer = null;
        let stem = '';
        try {
          const body = JSON.parse(raw);
          const user = [...body.messages].reverse().find((m) => m.role === 'user');
          const content = typeof user.content === 'string' ? user.content : JSON.stringify(user.content);
          const m = content.match(/题目：(.+)/);
          stem = m ? m[1].trim() : '';
          const key = Object.keys(FIXTURES).find((k) => stem.includes(k) || k.includes(stem));
          answer = key ? FIXTURES[key] : null;
          const optLines = content.split('\n').filter((l) => /^\s{2}[A-H]\./.test(l));
          calls.push({ stem, answer, optCount: optLines.length, optText: optLines.join(' | ') });
        } catch (e) {
          answer = null;
        }
        const content = JSON.stringify({ answer, confidence: answer === null ? 0.1 : 0.97, reason: 'e2e-stub' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'stub', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, calls }));
  });
}

async function launch() {
  // 和线上路径一致：外部起一个带调试端口的浏览器，再用 CDP 接管
  const port = 9400 + Math.floor(Math.random() * 400);
  const endpoint = `http://127.0.0.1:${port}`;
  const cfg = {
    browser: {
      channel: 'msedge',
      executablePath: '',
      debugPort: port,
      cdpEndpoint: endpoint,
      userDataDir: path.join(os.tmpdir(), `aa-e2e-${Date.now()}`),
      headless: true,
      url: '',
    },
  };
  if (!findExecutable(cfg)) throw new Error('没找到 Edge/Chrome，无法跑端到端自测');
  const child = launchDebugBrowser(cfg);
  const ok = await waitCdp(endpoint, 60000);
  if (!ok) { try { child.kill(); } catch (e) {} throw new Error('调试端口未就绪'); }
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
  const page = browser.contexts()[0].pages()[0] || await browser.contexts()[0].newPage();
  return { browser, page, async close() { try { await browser.close(); } catch (e) {} try { child.kill(); } catch (e) {} } };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function main() {
  const staticSrv = await serveStatic();
  const fake = await serveFakeModel();
  const port = staticSrv.address().port;
  const llmPort = fake.server.address().port;

  const cfg = loadConfig();
  cfg.llm.baseURL = `http://127.0.0.1:${llmPort}/v1`;
  cfg.llm.apiKey = 'test-key';
  cfg.llm.model = 'stub-model';
  cfg.llm.jsonMode = false;
  cfg.agent.delayMs = 60;
  cfg.agent.waitChangeMs = 6000;
  cfg.agent.recordFile = path.join(TEST_DIR, 'runs', 'answers.jsonl');
  fs.rmSync(path.join(TEST_DIR, 'runs'), { recursive: true, force: true });

  const browser = await launch();
  const page = browser.page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/mock-quiz.html`, { waitUntil: 'domcontentloaded' });

  const stats = await runAgent(page, cfg, makeLlmSolver(cfg));
  const quiz = await page.evaluate(() => window.__quizDone || null);
  if (quiz) {
    const detail = await page.evaluate(() => {
      const el = document.querySelector('.result .detail');
      return el ? el.textContent : '';
    });
    console.log('--- 页面判分明细 ---\n' + detail);
  }
  const files = fs.existsSync(cfg.agent.recordFile) ? fs.readFileSync(cfg.agent.recordFile, 'utf8').trim().split('\n').filter(Boolean) : [];

  check('模型被调用 8 次（每题一次）', fake.calls.length === 8, `实际 ${fake.calls.length} 次`);
  check('每题都识别出了题干', fake.calls.every((c) => c.stem.length > 2));
  check('每题都给出了答案', fake.calls.every((c) => c.answer !== null));
  check('8 题全部作答成功', stats.ok === 8, `ok=${stats.ok} total=${stats.total} skipped=${stats.skipped} reason=${stats.reason}`);
  check('自动点击了提交', stats.submitted === true);
  check('页面判分为 100 分', !!quiz && quiz.score === 100, quiz ? `score=${quiz.score} (${quiz.right}/${quiz.total})` : '页面未出现结果');
  check('答案 JSONL 记录了 8 条', files.length === 8, `实际 ${files.length} 条`);
  check('记录内容可解析且带题干', files.every((l) => { const o = parseJSONLoose(l); return o && o.stem && o.applied; }));

  if (errors.length) check('页面无 JS 报错', false, errors.join(' | '));
  else check('页面无 JS 报错', true);

  // ---- 第二轮：dry-run 只出答案，不填不交 ----
  await page.goto(`http://127.0.0.1:${port}/mock-quiz.html`, { waitUntil: 'domcontentloaded' });
  cfg.agent.dryRun = true;
  const dryStats = await runAgent(page, cfg, makeLlmSolver(cfg));
  const dryQuiz = await page.evaluate(() => window.__quizDone || null);
  check('dry-run 遍历了全部题目', dryStats.total === 8, `total=${dryStats.total} reason=${dryStats.reason}`);
  check('dry-run 不提交', dryStats.submitted === false && dryQuiz === null);
  check('dry-run 不落答案', (await page.evaluate(() => document.querySelectorAll('input:checked').length)) === 0);

  // ---- 第三轮：自动检测标签页（含一个干扰的登录页）----
  await page.goto(`http://127.0.0.1:${port}/decoy.html`, { waitUntil: 'domcontentloaded' });
  const quizPage = await page.context().newPage();
  await quizPage.goto(`http://127.0.0.1:${port}/mock-quiz.html`, { waitUntil: 'domcontentloaded' });
  cfg.agent.dryRun = false;

  const hit = await detectTarget(browser.browser, cfg);
  check('自动检测选中题目页（不是登录页）', !!hit && hit.page === quizPage,
    hit ? `选中 ${hit.page.url()} 得分=${hit.score}` : '没找到');

  const autoStats = await runAgent(hit ? hit.page : quizPage, cfg, makeLlmSolver(cfg), {
    reacquire: async (current) => {
      const r = await detectTarget(browser.browser, cfg);
      return r && r.page !== current ? r.page : null;
    },
  });
  const autoQuiz = await quizPage.evaluate(() => window.__quizDone || null);
  check('自动检测后仍答对 8 题', autoStats.ok === 8 && !!autoQuiz && autoQuiz.score === 100,
    `ok=${autoStats.ok} score=${autoQuiz ? autoQuiz.score : 'n/a'}`);

  // ---- 第四轮：各种“没有下一题按钮”的跳转方式 ----
  const base = `http://127.0.0.1:${port}`;
  const NAV_CASES = [
    { mode: 'keyboard', label: '键盘翻页', query: '?mode=keyboard' },
    { mode: 'url', label: 'URL 翻页', query: '?mode=url&p=1' },
    { mode: 'sidebar', label: '题号侧栏', query: '?mode=sidebar' },
    { mode: 'single', label: '一页多题（滚动）', query: '?mode=single' },
  ];
  for (const c of NAV_CASES) {
    const p = await browser.browser.contexts()[0].newPage();
    const logs = [];
    const off = onLog((ev) => logs.push(ev.text));
    await p.goto(`${base}/mock-nav.html${c.query}`, { waitUntil: 'domcontentloaded' });
    const st = await runAgent(p, cfg, makeLlmSolver(cfg));
    off();
    const done = await p.evaluate(() => window.__quizDone || null);
    const jump = logs.find((l) => l.includes('自动跳转：'));
    check(`${c.label}：8 题全对`, st.ok === 8 && !!done && done.score === 100,
      `ok=${st.ok} total=${st.total} score=${done ? done.score : 'n/a'} reason=${st.reason}`);
    check(`${c.label}：用了自动跳转`, !!jump, jump ? jump.split('自动跳转：')[1].split('（')[0] : '没触发');
    await p.close();
  }

  // ---- 第五轮：页面外壳的干扰控件（语言切换 / 页头 Next / 数字 2）不能被碰 ----
  const ctx = browser.browser.contexts()[0];
  for (const c of [
    { mode: 'button', label: '带干扰的按钮翻页', query: '?mode=button&lang=1' },
    { mode: 'url', label: '带 lang 参数的 URL 翻页', query: '?mode=url&lang=1&page=1' },
  ]) {
    const p = await ctx.newPage();
    await p.goto(`${base}/mock-chrome.html${c.query}`, { waitUntil: 'domcontentloaded' });
    const st = await runAgent(p, cfg, makeLlmSolver(cfg));
    const done = await p.evaluate(() => window.__quizDone || null);
    const cur = new URL(p.url());
    check(`${c.label}：8 题全对`, st.ok === 8 && !!done && done.score === 100,
      `ok=${st.ok} total=${st.total} score=${done ? done.score : 'n/a'} reason=${st.reason}`);
    const traps = done ? done.traps : null;
    check(`${c.label}：没点语言/页头按钮`, !!traps && !traps.lang && !traps.next && !traps.langNum, JSON.stringify(traps));
    check(`${c.label}：没动 lang 参数`, cur.searchParams.get('lang') === '1', cur.search || '(无参数)');
    await p.close();
  }

  // ---- 语言选择页不应该被当成题目页 ----
  const langPage = await ctx.newPage();
  await langPage.goto(`${base}/mock-lang.html`, { waitUntil: 'domcontentloaded' });
  const quizTab = await ctx.newPage();
  await quizTab.goto(`${base}/mock-chrome.html?mode=button`, { waitUntil: 'domcontentloaded' });
  const picked = await detectTarget(browser.browser, cfg);
  check('语言选择页不被当成题目页', !!picked && picked.page === quizTab,
    picked ? `${picked.page.url()} score=${picked.score}` : '没找到');
  await langPage.close();
  await quizTab.close();

  // ---- 第六轮：复刻真实页面（题卡内带语言切换、按钮组容器、短选项）----
  const judgePage = await ctx.newPage();
  await judgePage.goto(`${base}/mock-judge.html`, { waitUntil: 'domcontentloaded' });
  const beforeCalls = fake.calls.length;
  const jStats = await runAgent(judgePage, cfg, makeLlmSolver(cfg));
  const jDone = await judgePage.evaluate(() => window.__quizDone || null);
  const jCalls = fake.calls.slice(beforeCalls);
  check('判断题页：8 题全对', jStats.ok === 8 && !!jDone && jDone.score === 100,
    `ok=${jStats.ok} total=${jStats.total} score=${jDone ? jDone.score : 'n/a'} reason=${jStats.reason}`);
  check('判断题页：每题只有 A/B 两个选项（没混进 中/EN）',
    jCalls.length === 8 && jCalls.every((c) => c.optCount === 2 && !/中|EN/.test(c.optText)),
    jCalls.map((c) => c.optCount).join(',') + ' | ' + (jCalls[0] ? jCalls[0].optText : ''));
  check('判断题页：没点语言切换', !!jDone && !jDone.traps.langZh && !jDone.traps.langEn, JSON.stringify(jDone && jDone.traps));
  await judgePage.close();

  await browser.close();
  staticSrv.close();
  fake.server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
