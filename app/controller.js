// 面板背后的控制器：持有一个浏览器连接 + 一轮答题的状态机
import fs from 'node:fs';
import { loadConfig, applyOverrides } from '../src/config.js';
import { openBrowser } from '../src/browser.js';
import { detectTarget, scanTabs } from '../src/detect.js';
import { runAgent } from '../src/agent.js';
import { makeLlmSolver, makeMockSolver } from '../src/solver.js';
import { info, warn, error } from '../src/log.js';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, patch) {
  if (!isObj(patch)) return patch;
  const out = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

export class Controller {
  constructor({ configPath = 'config.json', mock = false, fixtures = 'test/fixtures/answers.json' } = {}) {
    this.configPath = configPath;
    this.mock = mock;
    this.fixtures = fixtures;
    this.cfg = this.load();
    this.browser = null;
    this.page = null;
    this.closeBrowser = null;
    this.running = false;
    this.abort = false;
    this.state = {
      status: 'idle',
      connected: false,
      tab: null,
      candidates: [],
      progress: { answered: 0, total: 0, skipped: 0 },
      last: null,
      result: null,
      error: '',
      startedAt: null,
      finishedAt: null,
    };
  }

  load() {
    const exists = fs.existsSync(this.configPath);
    return applyOverrides(loadConfig(exists ? this.configPath : ''), {});
  }

  /** 供 UI 展示的配置（不含明文 key） */
  publicConfig() {
    const c = this.cfg;
    return {
      llm: {
        baseURL: c.llm.baseURL,
        model: c.llm.model,
        apiKeyEnv: c.llm.apiKeyEnv,
        keySet: !!c.llm.apiKey,
        temperature: c.llm.temperature,
      },
      agent: {
        delayMs: c.agent.delayMs,
        autoSubmit: c.agent.autoSubmit,
        confidenceThreshold: c.agent.confidenceThreshold,
        recordFile: c.agent.recordFile,
        maxQuestions: c.agent.maxQuestions,
        nextStrategies: c.agent.nextStrategies,
        nextKeys: c.agent.nextKeys,
      },
      browser: { mode: c.browser.mode, cdpEndpoint: c.browser.cdpEndpoint, channel: c.browser.channel },
      mock: this.mock,
    };
  }

  saveConfig(patch) {
    const exists = fs.existsSync(this.configPath);
    const current = exists ? JSON.parse(fs.readFileSync(this.configPath, 'utf8')) : {};
    // 空字符串表示“不改”，避免把已保存的 key 清掉
    if (patch?.llm && !patch.llm.apiKey) delete patch.llm.apiKey;
    const merged = deepMerge(current, patch || {});
    fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2), 'utf8');
    this.cfg = this.load();
    info(`配置已保存到 ${this.configPath}`);
    return this.publicConfig();
  }

  async connect() {
    if (this.browser) return { ok: true, reused: true };
    try {
      const opened = await openBrowser(this.cfg);
      this.browser = opened.browser;
      this.page = opened.page;
      this.closeBrowser = opened.close;
      this.state.connected = true;
      this.state.status = 'idle';
      return { ok: true };
    } catch (e) {
      this.state.status = 'error';
      this.state.error = e.message;
      error(`连接浏览器失败：${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  async disconnect() {
    if (this.closeBrowser) { try { await this.closeBrowser(); } catch (e) {} }
    this.browser = null; this.page = null; this.closeBrowser = null;
    this.state.connected = false;
    this.state.tab = null;
  }

  /** 扫描全部标签页，挑出题目页 */
  async scan() {
    if (!this.browser) {
      const r = await this.connect();
      if (!r.ok) return { ok: false, error: r.error };
    }
    try {
      const list = await scanTabs(this.browser, this.cfg);
      this.state.candidates = list.map((r) => ({
        score: r.score,
        title: r.q.title || '(无标题)',
        url: r.page.url(),
        reasons: r.reasons || [],
      }));
      const best = await detectTarget(this.browser, this.cfg);
      if (best) {
        this.page = best.page;
        this.state.tab = { title: best.q.title || '(无标题)', url: best.page.url(), score: best.score };
        info(`识别到题目页：${this.state.tab.title}（${best.score} 分）`);
      } else {
        this.state.tab = null;
        warn('没有找到像题目页的标签页，请在浏览器里打开题目页后重新扫描');
      }
      return { ok: true, tab: this.state.tab, candidates: this.state.candidates };
    } catch (e) {
      this.state.error = e.message;
      error(`扫描失败：${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  /** 点“开始”：先做同步校验，再后台跑，状态通过 snapshot() 轮询 */
  async start(opts = {}) {
    if (this.running) return { ok: false, error: '正在答题中' };
    if (this.mock) {
      if (!fs.existsSync(this.fixtures)) return { ok: false, error: `演示答案表不存在：${this.fixtures}` };
    } else if (!this.cfg.llm.apiKey) {
      const msg = `未配置 API Key：设置环境变量 ${this.cfg.llm.apiKeyEnv}，或在设置里填写`;
      this.state.status = 'error';
      this.state.error = msg;
      error(msg);
      return { ok: false, error: msg };
    }

    this.running = true;
    this.abort = false;
    this.state.status = 'starting';
    this.state.error = '';
    this.state.result = null;
    this.state.last = null;
    this.state.progress = { answered: 0, total: 0, skipped: 0 };
    this.state.startedAt = Date.now();
    this.state.finishedAt = null;
    this.state.dryRun = !!opts.dryRun;

    this.runPromise = this._run(opts).catch((e) => {
      this.state.status = 'error';
      this.state.error = e.message;
      error(`答题异常：${e.message}`);
    }).finally(() => {
      this.running = false;
      this.abort = false;
    });
    return { ok: true, started: true };
  }

  async _run(opts) {
    if (!this.browser) {
      const r = await this.connect();
      if (!r.ok) throw new Error(r.error);
    }

    if (opts.url) {
      if (!this.page) this.page = await this.browser.contexts()[0].newPage();
      await this.page.goto(opts.url, { waitUntil: 'domcontentloaded' });
    }
    if (!this.page) {
      const s = await this.scan();
      if (!s.ok || !this.page) throw new Error(s.error || '没有可答题的标签页');
    }

    const runCfg = applyOverrides(this.cfg, {
      dryRun: !!opts.dryRun,
      autoSubmit: opts.autoSubmit === undefined ? this.cfg.agent.autoSubmit : !!opts.autoSubmit,
      max: opts.maxQuestions ? Number(opts.maxQuestions) : undefined,
      record: opts.recordFile || this.cfg.agent.recordFile,
    });
    const solver = this.mock ? makeMockSolver(this.fixtures) : makeLlmSolver(runCfg);

    this.state.status = 'running';
    const page = this.page;
    info(`开始答题（${this.mock ? '演示模式' : '模型模式'}${opts.dryRun ? '，dry-run' : ''}）`);

    let stats;
    try {
      stats = await runAgent(page, runCfg, solver, {
        shouldStop: () => this.abort,
        onRecord: (rec, st) => {
          this.state.last = {
            index: rec.index,
            stem: rec.stem,
            kind: rec.kind,
            answer: rec.answer,
            confidence: rec.confidence,
            applied: rec.applied,
            detail: rec.detail,
          };
          this.state.progress = { answered: st.ok, total: st.total, skipped: st.skipped };
        },
        reacquire: async (current) => {
          const hit = await detectTarget(this.browser, this.cfg);
          if (hit && hit.page !== current) {
            this.page = hit.page;
            this.state.tab = { title: hit.q.title || '', url: hit.page.url(), score: hit.score };
            return hit.page;
          }
          return null;
        },
      });
    } finally {
      this.state.status = 'done';
      this.state.finishedAt = Date.now();
      this.state.result = {
        reason: stats ? stats.reason : '异常结束',
        score: stats ? stats.score || '' : '',
        submitted: stats ? !!stats.submitted : false,
        ok: stats ? stats.ok : 0,
        total: stats ? stats.total : 0,
        skipped: stats ? stats.skipped : 0,
      };
      info(`本轮结束：${this.state.result.reason}（成功 ${this.state.result.ok} / 共 ${this.state.result.total}）`);
    }
    return this.state.result;
  }

  stop() {
    if (!this.running) return { ok: false, error: '当前没有在答题' };
    this.abort = true;
    info('收到停止请求，将在当前题结束后停止');
    return { ok: true };
  }

  snapshot() {
    return {
      ...this.state,
      running: this.running,
      config: this.publicConfig(),
    };
  }
}
