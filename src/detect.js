// 自动识别“题目页”：扫描所有标签页，给每个页面打分，挑最像考题的那个。
// 判据：有题干、有选项/填空/下拉、有下一步或提交按钮；结果页（已交卷）降权。
import { extractQuestion } from './extract.js';
import { info, warn } from './log.js';

const SKIP_URL = /^(about:|chrome|edge:|devtools:|chrome-extension:|edge-extension:|view-source:)/i;
// 语言选择页：选项全是语言名，或题干就是“选择语言”
const LANG_OPTION = /^(中文|简体中文|繁體中文|繁体中文|english|en|en-us|日本語|한국어|español|français|deutsch|русский|语言|語言|language)$/i;
const LANG_STEM = /^(请?选择语言|语言设置|语言选择|select\s*language|please\s*select\s*your\s*language|choose\s*language|language\s*setting)/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, fallback = null) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise.then((v) => v).catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

/** 给单个标签页打分；不是候选页返回 null */
export async function probePage(page, cfg, timeoutMs = 4000) {
  if (!page || page.isClosed()) return null;
  let url = '';
  try { url = page.url(); } catch (e) { return null; }
  if (!url || SKIP_URL.test(url)) return null;
  const q = await withTimeout(extractQuestion(page, cfg), timeoutMs);
  if (!q) return null;

  if (q.hasResult) return { page, q, score: -5 };

  let score = 0;
  const reasons = [];
  if (q.stem && q.stem.length >= 4) { score += 4; reasons.push('题干'); }
  if (q.options.length >= 2) { score += 3; reasons.push(`${q.options.length}个选项`); }
  if (q.blanks.length) { score += 2; reasons.push(`${q.blanks.length}个填空`); }
  if (q.selects.length) { score += 1; reasons.push('下拉'); }
  if (q.nextTarget || q.submitTarget) { score += 2; reasons.push(q.submitTarget ? '提交按钮' : '下一题按钮'); }
  if (q.kind !== 'unknown') { score += 1; }

  // 语言选择页不算题目
  const optTexts = q.options.map((o) => (o.text || '').trim());
  const allLang = optTexts.length >= 2 && optTexts.every((t) => LANG_OPTION.test(t));
  if (allLang) { score -= 8; reasons.push('全是语言选项'); }
  if (LANG_STEM.test((q.stem || '').trim())) { score -= 6; reasons.push('题干像语言设置'); }

  return { page, q, score, reasons };
}

/** 扫描全部标签页，按分数降序 */
export async function scanTabs(browser, cfg) {
  const pages = browser.contexts().flatMap((c) => c.pages());
  const scored = [];
  for (const p of pages) {
    const r = await probePage(p, cfg);
    if (r) scored.push(r);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** 找当前最像题目的标签页；分数太低视为没找到 */
export async function detectTarget(browser, cfg) {
  const list = await scanTabs(browser, cfg);
  if (!list.length) return null;
  return list[0].score >= 3 ? list[0] : null;
}

/** 等题目页出现（题目可能是点开链接后新开的标签页） */
export async function waitForTarget(browser, cfg, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let logged = 0;
  for (;;) {
    const hit = await detectTarget(browser, cfg);
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    if (logged < 2) {
      const tabs = browser.contexts().flatMap((c) => c.pages()).length;
      info(`等待题目页出现…（当前 ${tabs} 个标签页）`);
      logged += 1;
    }
    await sleep(1500);
  }
}

/** 打印候选页，便于排查“为什么没识别到” */
export function describeCandidates(list) {
  return list.map((r) => `${r.score} 分 [${(r.reasons || []).join('/')}] ${r.q.title || r.page.url()}`).join('\n  ');
}

export { warn };
