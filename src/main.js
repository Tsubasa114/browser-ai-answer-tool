#!/usr/bin/env node
// CLI 入口：node src/main.js --config config.json
import fs from 'node:fs';
import { loadConfig, applyOverrides, maskKey } from './config.js';
import { openBrowser } from './browser.js';
import { makeLlmSolver, makeMockSolver } from './solver.js';
import { detectTarget } from './detect.js';
import { runAgent } from './agent.js';
import { info, warn, error } from './log.js';

function parseArgs(argv) {
  const cli = {};
  const flags = {
    '--config': 'config', '--url': 'url', '--cdp': 'cdp', '--mode': 'mode',
    '--page-match': 'pageMatch', '--max': 'max', '--delay': 'delay',
    '--model': 'model', '--base-url': 'baseURL', '--record': 'record',
    '--api-key': 'apiKey', '--solver': 'solver', '--fixtures': 'fixtures',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') { cli.dryRun = true; continue; }
    if (a === '--headless') { cli.headless = true; continue; }
    if (a === '--show') { cli.headless = false; continue; }
    if (a === '--no-auto-submit') { cli.autoSubmit = false; continue; }
    if (a === '--no-pause') { cli.noPause = true; continue; }
    if (a === '--help' || a === '-h') { cli.help = true; continue; }
    const key = flags[a];
    if (key) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { cli[key] = true; }
      else { cli[key] = v; i += 1; }
      continue;
    }
    if (!a.startsWith('-') && !cli.url) { cli.url = a; continue; }
    warn(`忽略未知参数 ${a}`);
  }
  return cli;
}

const HELP = `
用法: node src/main.js [网址] --config config.json [选项]

  不给网址时自动扫描标签页，挑出有题目的那一页。

  --config <file>       配置文件（默认 config.json）
  --url <url>           指定要答题的页面（可选，不填就自动检测）
  --cdp <endpoint>      浏览器调试地址，默认 http://127.0.0.1:9222
  --mode cdp|launch     cdp=接管已开浏览器；launch=自己起一个
  --page-match <s>      指定 url 时，多标签页按 URL 子串选择
  --dry-run             只出答案，不填写、不提交（仍会翻页遍历题目）
  --max <n>             最多答多少题
  --delay <ms>          每题操作间隔
  --model <name>        LLM 模型名
  --base-url <url>      OpenAI 兼容接口地址
  --solver llm|mock     答题器（mock 用于离线自测）
  --fixtures <file>     mock 模式的答案表
  --no-auto-submit      遇到“提交/交卷”不自动点
  --no-pause            低置信度/无答案时不暂停
  --headless            launch 模式无头运行
`;

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) { console.log(HELP); return; }

  const cfgPath = cli.config || 'config.json';
  if (!fs.existsSync(cfgPath)) {
    if (cli.config) { error(`配置文件不存在: ${cli.config}`); process.exitCode = 2; return; }
    warn('未找到 config.json，使用内置默认值（可用 config.example.json 复制一份）');
  }
  const cfg = applyOverrides(loadConfig(fs.existsSync(cfgPath) ? cfgPath : ''), cli);

  info('=== 浏览器自动答题 ===');
  info(`接入方式: ${cfg.browser.mode} ${cfg.browser.mode === 'cdp' ? cfg.browser.cdpEndpoint : `(${cfg.browser.channel})`}`);
  info(`目标页  : ${cfg.browser.url ? cfg.browser.url : '自动检测（扫描标签页找题目）'}`);
  info(`模型: ${cfg.llm.model} @ ${cfg.llm.baseURL}  key=${maskKey(cfg.llm.apiKey)}`);
  info(`dry-run: ${cfg.agent.dryRun}  自动提交: ${cfg.agent.autoSubmit}  记录: ${cfg.agent.recordFile}`);

  let solver;
  if (cli.solver === 'mock') {
    solver = makeMockSolver(cli.fixtures || 'test/fixtures/answers.json');
    info(`答题器: ${solver.name}`);
  } else {
    solver = makeLlmSolver(cfg);
    if (!cfg.llm.apiKey) {
      error(`未配置 API Key：设置环境变量 ${cfg.llm.apiKeyEnv}，或用 --api-key 传入。`);
      process.exitCode = 2;
      return;
    }
  }

  const { browser, page, close } = await openBrowser(cfg);
  let stats;
  try {
    stats = await runAgent(page, cfg, solver, {
      // 题目跑到新标签页时，自动找到并切过去
      reacquire: async (current) => {
        const hit = await detectTarget(browser, cfg);
        return hit && hit.page !== current ? hit.page : null;
      },
    });
  } finally {
    await close();
  }

  console.log('');
  info('=== 结束 ===');
  info(`共识别 ${stats.total} 题，成功作答 ${stats.ok} 题，跳过 ${stats.skipped} 题`);
  info(`结束原因: ${stats.reason}${stats.submitted ? '（已提交）' : ''}`);
  if (stats.score) info(`结果页文字: ${stats.score.replace(/\s+/g, ' ').slice(0, 120)}`);
  info(`明细已写入 ${cfg.agent.recordFile}`);
}

main().catch((e) => {
  error(e && e.stack ? e.stack : String(e));
  process.exitCode = 1;
});
