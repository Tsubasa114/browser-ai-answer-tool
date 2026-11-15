// 浏览器接入：优先接管已开着的浏览器（CDP），需要时自带调试端口拉起一个
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { info, warn } from './log.js';
import { waitForTarget, scanTabs, describeCandidates } from './detect.js';

const CANDIDATES = {
  msedge: [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  chrome: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${os.homedir()}/AppData/Local/Google/Chrome/Application/chrome.exe`,
  ],
};

export function findExecutable(cfg) {
  if (cfg.browser.executablePath) return cfg.browser.executablePath;
  const list = CANDIDATES[cfg.browser.channel] || CANDIDATES.msedge;
  const hit = list.find((p) => fs.existsSync(p));
  return hit || '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitCdp(endpoint, timeoutMs = 30000) {
  const url = endpoint.replace(/\/+$/, '') + '/json/version';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch (e) {
      // 还没起来
    }
    await sleep(400);
  }
  return false;
}

/** 启动一个带远程调试端口的浏览器（独立配置目录，不影响你日常用的窗口） */
export function launchDebugBrowser(cfg) {
  const exe = findExecutable(cfg);
  if (!exe) throw new Error(`没找到 ${cfg.browser.channel} 可执行文件，请设置 browser.executablePath`);
  const port = Number(cfg.browser.debugPort) || 9222;
  const profile = cfg.browser.userDataDir
    ? path.resolve(cfg.browser.userDataDir)
    : path.join(process.cwd(), '.browser-profile');
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSidebarV2',
  ];
  if (cfg.browser.headless) args.push('--headless=new', '--disable-gpu');
  if (cfg.browser.url) args.push(cfg.browser.url);
  info(`启动浏览器：${exe} (调试端口 ${port})，配置目录 ${profile}`);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

function pickPage(browser, cfg) {
  const pages = browser.contexts().flatMap((c) => c.pages());
  if (!pages.length) return null;
  if (cfg.browser.pageMatch) {
    const hit = pages.find((p) => p.url().includes(cfg.browser.pageMatch));
    if (hit) return hit;
    warn(`没有标签页匹配 pageMatch="${cfg.browser.pageMatch}"，改用最后一个标签页`);
  }
  const real = pages.filter((p) => !/^(about:blank|edge:\/\/|chrome:\/\/)/.test(p.url()));
  return real[real.length - 1] || pages[pages.length - 1];
}

async function newPage(browser) {
  const ctx = browser.contexts()[0] || await browser.newContext();
  return ctx.newPage();
}

/**
 * 选目标页：
 *   1) 配置了 url  -> 直接打开/复用该网址
 *   2) 没配置 url  -> 自动扫描标签页，挑最像题目页的那个；等一会儿还没出现就挂到当前页
 */
async function acquirePage(browser, cfg) {
  if (cfg.browser.url) {
    const page = pickPage(browser, cfg) || await newPage(browser);
    if (!page.url().startsWith(cfg.browser.url)) {
      await page.goto(cfg.browser.url, { waitUntil: 'domcontentloaded' }).catch((e) => warn(`打开网址失败：${e.message}`));
    }
    return page;
  }

  // launch 模式是自己造一个干净浏览器，里面没有你的标签页可扫，直接给空白页
  if (cfg.browser.mode === 'launch' && !cfg.browser.url) {
    warn('launch 模式没有给网址：浏览器是空的，请用 --url 指定题目页（自动检测只在接管已有浏览器时有效）');
    return pickPage(browser, cfg) || await newPage(browser);
  }

  if (cfg.browser.autoDetect !== false) {
    const timeout = cfg.browser.detectTimeoutMs ?? 20000;
    info('未指定网址，自动扫描标签页查找题目…');
    const hit = await waitForTarget(browser, cfg, timeout);
    if (hit) {
      info(`自动识别到题目页（${hit.score} 分：${(hit.reasons || []).join('/')}）`);
      info(`  ${hit.q.title || '(无标题)'}  ${hit.page.url()}`);
      const others = (await scanTabs(browser, cfg)).filter((r) => r.page !== hit.page && r.score > 0);
      if (others.length) info(`  其它候选：\n  ${describeCandidates(others)}`);
      return hit.page;
    }
    const all = await scanTabs(browser, cfg);
    warn(`没检测到题目页（共扫描 ${all.length} 个标签页）。先挂到当前页，打开题目后会自动重新识别。`);
    if (all.length) warn(`  候选：\n  ${describeCandidates(all)}`);
  }

  return pickPage(browser, cfg) || await newPage(browser);
}

/**
 * @returns {{browser, page, owned:boolean, close:Function}}
 */
export async function openBrowser(cfg) {
  const mode = cfg.browser.mode || 'cdp';
  const endpoint = cfg.browser.cdpEndpoint || `http://127.0.0.1:${cfg.browser.debugPort || 9222}`;

  if (mode === 'launch') {
    const exe = findExecutable(cfg);
    if (!exe) throw new Error('没找到可用的浏览器，请设置 browser.executablePath');
    const browser = await chromium.launch({
      executablePath: exe,
      headless: !!cfg.browser.headless,
      slowMo: cfg.browser.slowMo || 0,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
    const page = await acquirePage(browser, cfg);
    info(`已启动浏览器（模式 launch），当前页面 ${page.url()}`);
    return { browser, page, owned: true, close: async () => { await browser.close(); } };
  }

  let browser;
  let spawned = null;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 8000 });
  } catch (e) {
    if (!cfg.browser.autoLaunch) {
      throw new Error(`连不上 CDP ${endpoint}。请先用调试端口启动浏览器，或把 browser.autoLaunch 设为 true。原始错误：${e.message}`);
    }
    warn(`连不上 ${endpoint}，自动拉起浏览器…`);
    // 自动拉起时必须和 cdpEndpoint 用同一个端口，否则连不上刚起的实例
    let port = cfg.browser.debugPort || 9222;
    try { port = Number(new URL(endpoint).port) || port; } catch (e) {}
    spawned = launchDebugBrowser({ ...cfg, browser: { ...cfg.browser, debugPort: port } });
    const ok = await waitCdp(endpoint, 35000);
    if (!ok) throw new Error(`浏览器启动了但调试端口 ${endpoint} 没响应`);
    browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
  }

  const page = await acquirePage(browser, cfg);
  await page.bringToFront().catch(() => {});
  info(`已接管标签页：${page.url()}  「${(await page.title().catch(() => '')).slice(0, 40)}」`);

  return {
    browser,
    page,
    owned: !!spawned,
    close: async () => {
      if (!spawned) {
        // 接管用户自己的浏览器：只断开连接，不关窗口
        info('已断开连接，浏览器保持打开');
        return;
      }
      try { await browser.close(); } catch (e) {}
      try { spawned.kill(); } catch (e) {}
    },
  };
}
