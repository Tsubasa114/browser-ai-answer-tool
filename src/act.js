// 页面操作：按答案点击/填表，并校验是否真的生效
import { warn, info } from './log.js';
import { NAV, NAV_ORDER, SAFE_STRATEGIES, stemChanged } from './nav.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 点击某个元素；失败时退回 DOM 原生 click()。返回是否成功派发 */
async function robustClick(page, sel) {
  if (!sel) return false;
  const loc = page.locator(sel).first();
  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await loc.click({ timeout: 3000 });
    return true;
  } catch (e) {
    try {
      const ok = await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return false;
        el.click();
        return true;
      }, sel);
      return ok;
    } catch (e2) {
      return false;
    }
  }
}

/** 读取单个选项的勾选状态 */
async function isChecked(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    if (el.tagName === 'INPUT') return !!el.checked;
    const aria = el.getAttribute('aria-checked');
    if (aria !== null) return aria === 'true';
    return /(^|[\s_-])(checked|selected|active)([\s_-]|$)/.test(el.className || '');
  }, sel).catch(() => null);
}

/** 强制把 radio/checkbox 置位并派发事件（用于自定义控件的兜底） */
async function forceCheck(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const input = el.tagName === 'INPUT' ? el : el.querySelector('input');
    if (!input) return false;
    input.checked = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, sel).catch(() => false);
}

/** 写入输入框；用原生 setter 触发 React/Vue 的受控更新 */
async function setFieldValue(page, sel, value) {
  const loc = page.locator(sel).first();
  try {
    await loc.click({ timeout: 2000 }).catch(() => {});
    await loc.fill(String(value), { timeout: 3000 });
  } catch (e) {
    // 退回 JS 写入
  }
  const applied = await page.evaluate(({ s, v }) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (el.isContentEditable) {
      el.textContent = v;
    } else if (desc && desc.set) {
      desc.set.call(el, v);
    } else {
      el.value = v;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.isContentEditable ? el.textContent : el.value;
  }, { s: sel, v: String(value) }).catch(() => null);
  return applied;
}

/**
 * 把模型给的选择落到页面上。
 * decision: { keys?: string[], value?: string, values?: {index, text}[] }
 */
export async function applyDecision(page, q, decision, cfg) {
  const detail = [];

  if (q.kind === 'single' || q.kind === 'multiple') {
    const want = (decision.keys || []).map((k) => String(k).toUpperCase());
    if (!want.length) return { applied: false, detail: '模型未给出选项' };
    const picked = q.options.filter((o) => want.includes(o.key));
    if (!picked.length) return { applied: false, detail: `选项 ${want.join(',')} 不在页面选项中` };

    if (q.kind === 'single' && picked.length > 1) {
      warn(`单选却给了多个选项 (${want.join(',')})，只取第一个`);
      picked.length = 1;
    }
    for (const opt of picked) {
      let clicked = false;
      if (opt.clickSel) clicked = await robustClick(page, opt.clickSel);
      if (!clicked && opt.inputSel) clicked = await robustClick(page, opt.inputSel);
      await sleep(120);
      const state = opt.inputSel ? await isChecked(page, opt.inputSel) : await isChecked(page, opt.clickSel || '');
      if (state !== true) {
        if (opt.inputSel) await forceCheck(page, opt.inputSel);
        else if (opt.clickSel) await forceCheck(page, opt.clickSel);
      }
      detail.push(`${opt.key}(${opt.text.slice(0, 18)})`);
    }
    const after = await page.evaluate((sels) => sels.map((s) => {
      const el = document.querySelector(s);
      return el && el.tagName === 'INPUT' ? !!el.checked : null;
    }), picked.map((o) => o.inputSel).filter(Boolean)).catch(() => []);
    const allOn = after.length ? after.every((v) => v === true) : null;
    return { applied: allOn !== false, detail: `选择 ${detail.join(' ')}` };
  }

  if (q.kind === 'blank') {
    const text = decision.value !== undefined ? String(decision.value) : '';
    if (!text) return { applied: false, detail: '模型未给出填空内容' };
    const parts = text.split(/\s*[|｜]\s*/); // 多个空用 | 分隔
    for (let i = 0; i < q.blanks.length; i += 1) {
      const v = parts[i] !== undefined ? parts[i] : text;
      const got = await setFieldValue(page, q.blanks[i].target, v);
      detail.push(`#${i + 1}=${String(got).slice(0, 20)}`);
    }
    return { applied: true, detail: `填空 ${detail.join(' ')}` };
  }

  if (q.kind === 'select') {
    const want = String(decision.value || '').trim();
    const sel = q.selects[0];
    if (!sel || !want) return { applied: false, detail: '没有可用的下拉框或答案为空' };
    const hit = sel.options.find((o) => o.text === want || o.value === want) ||
                sel.options.find((o) => o.text.includes(want) || want.includes(o.text));
    if (!hit) return { applied: false, detail: `下拉项里找不到 “${want}”` };
    try {
      await page.locator(sel.target).first().selectOption({ value: hit.value });
    } catch (e) {
      await page.locator(sel.target).first().selectOption({ label: hit.text });
    }
    return { applied: true, detail: `下拉选中 ${hit.text}` };
  }

  return { applied: false, detail: `未知题型 ${q.kind}` };
}

/**
 * 跳到下一题：按钮 → 题号侧栏 → URL 翻页 → 键盘 → 滚动（一页多题）→ 提交
 * @returns {{action:'next'|'submit'|'none', how:string}}
 */
export async function advance(page, q, cfg, ctx = {}) {
  const autoSubmit = cfg.agent.autoSubmit !== false;

  // 1) 页面上明确的“下一题”按钮
  if (q.nextTarget) {
    const ok = await robustClick(page, q.nextTarget);
    info(`点击 “${q.nextText}”${q.nextInScope ? '（题卡内）' : ''}`, ok ? 'ok' : '失败');
    if (await stemChanged(page, q, cfg, 1800)) return { action: 'next', how: '按钮' };
  }

  // 2) 其它跳转方式：有提交按钮时只用不会误交卷的策略（题号侧栏 / 滚动）
  const order = (cfg.agent.nextStrategies || NAV_ORDER).filter((n) => NAV[n]);
  const safeOnly = !!q.submitTarget;
  for (const name of order) {
    if (safeOnly && !SAFE_STRATEGIES.has(name)) continue;
    const t0 = Date.now();
    let ok = false;
    try { ok = await NAV[name].run(page, q, cfg, ctx); } catch (e) { ok = false; }
    if (ok) {
      info(`自动跳转：${NAV[name].label}（${Date.now() - t0} ms）`);
      return { action: 'next', how: name };
    }
  }

  // 3) 实在没有下一题了，才提交
  if (q.submitTarget && autoSubmit) {
    const ok = await robustClick(page, q.submitTarget);
    info(`点击提交按钮 “${q.submitText}”${q.submitInScope ? '（题卡内）' : ''}`, ok ? 'ok' : '失败');
    return { action: 'submit', how: '按钮' };
  }
  return { action: 'none', how: '' };
}

/** 等页面“换题”：题干变化 / 出现结果区 / URL 变化 / 题干消失 */
export async function waitForAdvance(page, before, cfg, extract) {
  const deadline = Date.now() + (cfg.agent.waitChangeMs || 15000);
  while (Date.now() < deadline) {
    await sleep(250);
    const cur = await extract(page, cfg).catch(() => null);
    if (!cur) continue;
    if (cur.hasResult) return { advanced: true, cur };
    if (before.stem && cur.stem && cur.stem !== before.stem) return { advanced: true, cur };
    if (before.url !== cur.url) return { advanced: true, cur };
  }
  return { advanced: false, cur: null };
}

export function signature(q) {
  return `${q.stem}|${q.options.map((o) => o.key).join('')}|${q.blanks.length}`;
}
