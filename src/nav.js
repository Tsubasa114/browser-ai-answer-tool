// 自动跳到下一题：多种策略，按顺序尝试，能改成功才返回 true。
// 有些站点没有“下一题”按钮：靠题号侧栏、URL 翻页、键盘快捷键，或者一页多题需要滚动。
import { extractQuestion } from './extract.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询页面，判断“当前题”是否已经变了 */
export async function stemChanged(page, before, cfg, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(180);
    const cur = await extractQuestion(page, cfg).catch(() => null);
    if (!cur) continue;
    if (cur.hasResult) return true;
    if (cur.stem && before.stem && cur.stem !== before.stem) return true;
    if (!before.stem && cur.stem) return true;
  }
  return false;
}

/** 题号侧栏：点“第 N 题”跳到下一题（只在导航容器里找，且排除语言切换） */
async function navSidebar(page, q, cfg, ctx) {
  const want = (ctx.index || 0) + 1;
  const clicked = await page.evaluate(({ want }) => {
    const norm = (s) => String(s || '').replace(/\s+/g, '').trim();
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };
    const CHROME = 'header,nav,[role="banner"],[class*="lang"],[class*="locale"],[class*="i18n"],[class*="switch"],[class*="toolbar"],[class*="topbar"],[class*="header"]';
    const inChrome = (el) => { try { return !!el.closest(CHROME); } catch (e) { return false; } };
    const LANG = /^(语言|語言|中文|简体中文|繁體中文|English|EN|日本語|한국어|Language)$/i;
    const NAV_HINT = /nav|side|menu|list|tabs|index|pager|question|card|toolbar/i;
    const inNav = (el) => {
      let n = el;
      for (let i = 0; n && i < 5; i += 1) {
        if (NAV_HINT.test(n.className || '') || NAV_HINT.test(n.id || '')) return true;
        n = n.parentElement;
      }
      return false;
    };
    const candidates = Array.from(document.querySelectorAll('a,button,li,span,div,td'))
      .filter((el) => el.isConnected && visible(el) && !el.disabled)
      .filter((el) => !inChrome(el) && !LANG.test(norm(el.innerText)))
      .filter((el) => inNav(el));

    const byLabel = candidates
      .filter((el) => ['第' + want + '题', '第' + want + '問'].includes(norm(el.innerText)));
    if (byLabel.length) {
      byLabel.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      byLabel[0].click();
      return true;
    }

    // 只有纯数字时，要求它是一组题号（至少 3 个同类数字），避免点到“1/2”这种语言切换
    const byNumber = candidates.filter((el) => norm(el.innerText) === String(want));
    for (const el of byNumber) {
      const parent = el.parentElement;
      if (!parent) continue;
      const numeric = Array.from(parent.children).filter((c) => /^\d+$/.test(norm(c.innerText)));
      if (numeric.length >= 3) { el.click(); return true; }
    }
    return false;
  }, { want }).catch(() => false);

  if (!clicked) return false;
  return stemChanged(page, q, cfg, 2500);
}

/** URL 翻页：只改“页码类”参数，绝不动 lang/locale 之类的参数 */
const PAGE_PARAMS = ['page', 'p', 'pc', 'cur', 'current', 'index', 'idx', 'q', 'question', 'step', 'no', 'num', 'pageno', 'pagenum', 'offset'];
const BLOCK_PARAMS = ['lang', 'language', 'locale', 'lng', 'hl', 'i18n', 'theme', 'themeid', 'v', 'ver', 'version', 't', 'ts', 'id', 'uid'];

async function navUrl(page, q, cfg, ctx) {
  let next = null;
  try {
    const u = new URL(page.url());
    const bump = (s) => String(Number(s) + 1);
    let done = false;
    // 只认页码类参数名
    for (const [k, v] of u.searchParams) {
      if (!/^\d+$/.test(v)) continue;
      const name = k.toLowerCase();
      if (BLOCK_PARAMS.includes(name)) continue;
      if (!PAGE_PARAMS.includes(name)) continue;
      u.searchParams.set(k, bump(v));
      done = true;
      break;
    }
    if (!done) {
      const m = u.hash.match(/^#?(?:page|p)=?(\d+)$/i) || u.hash.match(/^#(\d+)$/);
      if (m) { u.hash = '#' + bump(m[1]); done = true; }
    }
    if (!done) {
      // 路径以纯数字结尾（/exam/3）才认为是翻页
      const m = u.pathname.match(/\/(\d+)\/?$/);
      if (m) { u.pathname = u.pathname.replace(/\/(\d+)\/?$/, bump(m[1]) + '/'); done = true; }
    }
    if (!done) return false;
    next = u.toString();
  } catch (e) {
    return false;
  }
  if (next === page.url()) return false;
  await page.goto(next, { waitUntil: 'domcontentloaded' }).catch(() => {});
  return stemChanged(page, q, cfg, 3000);
}

/** 键盘：有的站点用 Enter / 方向键翻页 */
async function navKeyboard(page, q, cfg, ctx) {
  const keys = cfg.agent.nextKeys || ['Enter', 'ArrowRight', 'PageDown'];
  // 焦点如果在页头/导航/语言切换上，先移走，免得回车去触发它们
  const safe = await page.evaluate(() => {
    const CHROME = 'header,nav,[role="banner"],[class*="lang"],[class*="locale"],[class*="i18n"],[class*="switch"],[class*="toolbar"]';
    const el = document.activeElement;
    if (el && el !== document.body) {
      const inChrome = (() => { try { return !!el.closest(CHROME); } catch (e) { return false; } })();
      if (inChrome) { el.blur(); return false; }
      el.blur();
    }
    return true;
  }).catch(() => true);
  if (!safe) return false;
  for (const key of keys) {
    try { await page.keyboard.press(key); } catch (e) { continue; }
    if (await stemChanged(page, q, cfg, 1400)) return true;
  }
  return false;
}

/** 一页多题：把下一道题滚到视口中间 */
async function navScroll(page, q, cfg, ctx) {
  const sels = (cfg.selectors && cfg.selectors.question) || [];
  const moved = await page.evaluate(({ sels }) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none';
    };
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    let stems = [];
    for (const s of sels) {
      let list = [];
      try { list = Array.from(document.querySelectorAll(s)); } catch (e) { continue; }
      list = list.filter((el) => visible(el) && norm(el.innerText || el.textContent).length >= 4);
      if (list.length) { stems = list; break; }
    }
    if (stems.length < 2) return false;

    const center = window.innerHeight / 2;
    let cur = 0;
    let best = Infinity;
    stems.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - center);
      if (d < best) { best = d; cur = i; }
    });
    const nextEl = stems[cur + 1];
    if (!nextEl) return false;
    nextEl.scrollIntoView({ block: 'center', behavior: 'instant' });
    const block = nextEl.closest('[class*="question"], li, article, section') || nextEl.parentElement;
    const focusable = block && block.querySelector('input,textarea,select');
    if (focusable) focusable.focus({ preventScroll: true });
    return true;
  }, { sels }).catch(() => false);

  if (!moved) return false;
  return stemChanged(page, q, cfg, 2500);
}

export const NAV = {
  sidebar: { label: '题号侧栏', run: navSidebar },
  url: { label: 'URL 翻页', run: navUrl },
  keyboard: { label: '键盘快捷键', run: navKeyboard },
  scroll: { label: '滚动到下一题', run: navScroll },
};

export const NAV_ORDER = ['sidebar', 'url', 'keyboard', 'scroll'];

/** 有提交按钮时只允许“不会误交卷”的策略 */
export const SAFE_STRATEGIES = new Set(['sidebar', 'scroll']);
