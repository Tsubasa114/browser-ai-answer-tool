// 配置加载：默认值 <- config.json <- 环境变量
import fs from 'node:fs';

export const DEFAULTS = {
  browser: {
    mode: 'cdp',                        // cdp | launch
    cdpEndpoint: 'http://127.0.0.1:9222',
    autoLaunch: true,                   // CDP 连不上时自动拉起一个带调试端口的浏览器
    channel: 'msedge',                  // msedge | chrome | chromium
    executablePath: '',
    headless: false,
    url: '',                            // launch 模式要打开的网址；也可用 --url
    autoDetect: true,                   // 没给网址时，自动扫描标签页找题目页
    detectTimeoutMs: 20000,             // 自动检测最多等多久（题目可能在点链接后新开）
    pageMatch: '',                      // 多个标签页时，按 URL 子串选择
    userDataDir: '',                    // autoLaunch 用的独立配置目录
    debugPort: 9222,
    slowMo: 0,
  },
  llm: {
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    apiKey: '',                         // 空则读 apiKeyEnv
    temperature: 0,
    timeoutMs: 60000,
    maxRetries: 2,
    jsonMode: true,
    visionModel: '',                    // 填写后启用截图兜底（仅给出建议，不自动点击）
  },
  agent: {
    maxQuestions: 300,
    dryRun: false,
    autoSubmit: true,                   // 遇到“提交/交卷”是否直接点
    delayMs: 700,                       // 每题之间的缓冲
    waitChangeMs: 15000,                // 点下一题后等待题干变化的超时
    confidenceThreshold: 0.35,
    pauseOnLowConfidence: false,        // true: 低置信度不猜，停下来等人工
    pauseOnUnknown: true,               // true: 提取不到题目就停
    recordFile: 'runs/answers.jsonl',
    screenshotDir: 'runs/shots',
    stopTextRegex: '答题完成|交卷成功|提交成功|考试结束|您的得分|本次得分',
    // 自动跳下一题：按顺序尝试（button 由 nextTarget 单独处理）
    nextStrategies: ['sidebar', 'url', 'keyboard', 'scroll'],
    nextKeys: ['Enter', 'ArrowRight', 'PageDown'],
    ignoreTextRegex: '',                // 额外忽略的按钮文案（正则），如 "语言|切换|分享"
    loopWaitMs: 1500,
  },
  selectors: {
    question: ['[data-question]', '.question-title', '.question-stem', '.stem', '.topic', '#question', 'h2', 'h3'],
    optionInput: ['input[type=radio]', 'input[type=checkbox]'],
    optionLike: ['[class*="option"]', '[class*="choice"]', '[class*="answer-item"]'],
    blankInput: ['input[type=text]', 'input[type=search]', 'input[type=number]', 'textarea', '[contenteditable="true"]'],
    nextButton: ['#next', '.next-btn', '[data-action="next"]', '.next'],
    submitButton: ['#submit', '.submit-btn', '[data-action="submit"]', '.submit'],
    result: ['.result', '#result', '.score', '.exam-result'],
    // 页面外壳：这些区域里的按钮/控件一律不点（语言切换、页头、导航、工具栏…）
    chrome: ['header', 'nav', 'footer', 'aside', '[role="navigation"]', '[role="banner"]',
      '[class*="lang"]', '[class*="locale"]', '[class*="i18n"]', '[class*="switch"]',
      '[class*="toolbar"]', '[class*="breadcrumb"]', '[class*="topbar"]', '[class*="top-bar"]',
      '[class*="tabbar"]', '[class*="tab-bar"]'],
  },
  nextTextRegex: '下一题|下一頁|下一页|继续答题|继续|Next|下一道',
  submitTextRegex: '^(提交|交卷|确认提交|提交答卷|Submit|完成答题)',
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** 深拷贝，避免合并时 nested 对象被多个配置共享（改一处会影响另一处） */
function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isObj(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = clone(v[k]);
    return out;
  }
  return v;
}

/** 深合并：后面的覆盖前面的，数组整体替换 */
function merge(base, over) {
  if (!isObj(over)) return over === undefined ? clone(base) : clone(over);
  const out = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : clone(v);
  }
  return out;
}

export function loadConfig(configPath) {
  let fileCfg = {};
  if (configPath) {
    const abs = configPath;
    if (!fs.existsSync(abs)) throw new Error(`配置文件不存在: ${abs}`);
    fileCfg = JSON.parse(fs.readFileSync(abs, 'utf8'));
  }
  return merge(DEFAULTS, fileCfg);
}

/** 应用 CLI 覆盖项（已经解析成扁平对象） */
export function applyOverrides(cfg, cli) {
  const out = merge({}, cfg);
  if (cli.url) out.browser.url = cli.url;
  if (cli.cdp) out.browser.cdpEndpoint = cli.cdp;
  if (cli.mode) out.browser.mode = cli.mode;
  if (cli.pageMatch) out.browser.pageMatch = cli.pageMatch;
  if (cli.max) out.agent.maxQuestions = Number(cli.max);
  if (cli.dryRun) out.agent.dryRun = true;
  if (cli.delay !== undefined) out.agent.delayMs = Number(cli.delay);
  if (cli.model) out.llm.model = cli.model;
  if (cli.baseURL) out.llm.baseURL = cli.baseURL;
  if (cli.headless !== undefined) out.browser.headless = !!cli.headless;
  if (cli.autoSubmit !== undefined) out.agent.autoSubmit = !!cli.autoSubmit;
  if (cli.record) out.agent.recordFile = cli.record;
  if (cli.noPause) {
    out.agent.pauseOnLowConfidence = false;
    out.agent.pauseOnUnknown = false;
  }
  // API key：CLI > config > 环境变量
  if (cli.apiKey) out.llm.apiKey = cli.apiKey;
  if (!out.llm.apiKey && out.llm.apiKeyEnv) {
    out.llm.apiKey = process.env[out.llm.apiKeyEnv] || '';
  }
  return out;
}

export function maskKey(k) {
  if (!k) return '(未设置)';
  return k.length <= 8 ? '****' : `${k.slice(0, 4)}...${k.slice(-4)}`;
}
