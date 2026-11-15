// 页面体检：自动找到（或指定）题目页，打印工具对这道题的识别结果。
//   node tools/inspect.js                  # 自动扫描标签页
//   node tools/inspect.js --url "https://..." --shot runs/shot.png
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { launchDebugBrowser, waitCdp, findExecutable } from '../src/browser.js';
import { extractQuestion } from '../src/extract.js';
import { detectTarget, scanTabs, describeCandidates } from '../src/detect.js';
import { loadConfig, applyOverrides } from '../src/config.js';

const args = process.argv.slice(2);
const opt = { url: '', shot: '', headless: true, config: '' };
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--url') opt.url = args[++i];
  else if (args[i] === '--shot') opt.shot = args[++i];
  else if (args[i] === '--show') opt.headless = false;
  else if (args[i] === '--config') opt.config = args[++i];
  else if (!args[i].startsWith('-') && !opt.url) opt.url = args[i];
}

const cfg = applyOverrides(loadConfig(opt.config), { url: opt.url });
const port = 9800 + Math.floor(Math.random() * 150);
const endpoint = `http://127.0.0.1:${port}`;
if (!findExecutable(cfg)) { console.error('没找到 Edge/Chrome，请设置 browser.channel 或 executablePath'); process.exit(1); }

const child = launchDebugBrowser({
  ...cfg,
  browser: { ...cfg.browser, debugPort: port, cdpEndpoint: endpoint, headless: opt.headless, url: opt.url, userDataDir: path.join(os.tmpdir(), `aa-inspect-${Date.now()}`) },
});

let browser;
try {
  if (!(await waitCdp(endpoint, 60000))) throw new Error('调试端口未就绪');
  browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
  const ctx = browser.contexts()[0];

  let page;
  if (opt.url) {
    page = ctx.pages()[0] || await ctx.newPage();
    if (!page.url().startsWith(opt.url)) await page.goto(opt.url, { waitUntil: 'domcontentloaded' });
  } else {
    console.log('未指定网址，自动扫描标签页…');
    const hit = await detectTarget(browser, cfg);
    if (!hit) {
      const all = await scanTabs(browser, cfg);
      console.log('没找到像题目页的标签页（已扫描 ' + all.length + ' 个）：');
      if (all.length) console.log('  ' + describeCandidates(all));
      process.exit(1);
    }
    page = hit.page;
    console.log(`自动识别（${hit.score} 分：${(hit.reasons || []).join('/')}）`);
  }
  await page.waitForTimeout(1000); // 给前端渲染留时间
  const q = await extractQuestion(page, cfg);

  console.log('=== 页面 ===');
  console.log(`标题: ${q.title}`);
  console.log(`URL : ${q.url}`);
  console.log('');
  console.log('=== 识别结果 ===');
  console.log(`题型   : ${q.kind}  (radio=${q.counts.radios} checkbox=${q.counts.checks} 填空=${q.counts.blanks} 下拉=${q.counts.selects})`);
  console.log(`进度   : ${q.hint || '(无)'}`);
  console.log(`题干   : ${q.stem || '(未识别到，试着调整 selectors.question)'}`);
  q.options.forEach((o) => console.log(`   ${o.key}. ${o.text}${o.checked ? '  [已选]' : ''}`));
  q.blanks.forEach((b) => console.log(`   填空#${b.index + 1}: ${b.tag} placeholder=${JSON.stringify(b.placeholder)} 当前值=${JSON.stringify(b.value)}`));
  q.selects.forEach((s) => console.log(`   下拉#${s.index + 1}: ${s.options.map((o) => o.text).join(' / ')}`));
  console.log(`下一题 : ${q.nextTarget ? `“${q.nextText}”` : '(无)'}`);
  console.log(`提交   : ${q.submitTarget ? `“${q.submitText}”` : '(无)'}`);
  console.log(`结果区 : ${q.hasResult ? q.resultText.slice(0, 80) : '(无)'}`);

  if (opt.shot) {
    fs.mkdirSync(path.dirname(path.resolve(opt.shot)), { recursive: true });
    await page.screenshot({ path: opt.shot, fullPage: false });
    console.log(`\n截图已保存: ${opt.shot}`);
  }
} catch (e) {
  console.error('体检失败:', e.message);
  process.exitCode = 1;
} finally {
  try { if (browser) await browser.close(); } catch (e) {}
  try { child.kill(); } catch (e) {}
}
