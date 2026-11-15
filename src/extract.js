// DOM 提取：把当前题目解析成结构化对象。
// 这个函数会被序列化进页面里执行，因此不能引用外部变量。
// 返回结构：
// { url, title, hint, stem, contextText, kind, options[], blanks[], selects[],
//   nextTarget, nextText, submitTarget, submitText, hasResult, resultText, counts, stemCount }
//
// 一页多题（单页考卷）也支持：按“离视口中心最近”的题干确定当前题，并把选项/填空
// 限制在这一题所在区块内，避免把后面几题的选项混进来。

const PAGE_FN = /* js */ `
(cfg, prefix) => {
  const S = cfg.selectors || {};
  const pick = (k, d) => (Array.isArray(cfg[k]) && cfg[k].length ? cfg[k] : (Array.isArray(S[k]) && S[k].length ? S[k] : d));
  const norm = (s) => String(s || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
  const elText = (el) => norm(el ? (el.innerText !== undefined ? el.innerText : el.textContent) : '');
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05;
  };
  const stamp = (el, suffix) => {
    const id = prefix + suffix;
    el.setAttribute('data-dsh-aa', id);
    return '[data-dsh-aa="' + id + '"]';
  };
  const queryVisible = (sels) => {
    const out = [];
    for (const s of sels || []) {
      let list = [];
      try { list = Array.from(document.querySelectorAll(s)); } catch (e) { continue; }
      for (const el of list) if (visible(el)) out.push(el);
      if (out.length) return out;
    }
    return out;
  };
  const isCheckedEl = (el) => {
    if (!el) return false;
    if (el.tagName === 'INPUT') return !!el.checked;
    const aria = el.getAttribute('aria-checked');
    if (aria !== null) return aria === 'true';
    return /(^|[\\s_-])(checked|selected|active)([\\s_-]|$)/.test(el.className || '');
  };
  const labelFor = (inp) => {
    if (inp.id) {
      let l = null;
      try { l = document.querySelector('label[for="' + CSS.escape(inp.id) + '"]'); } catch (e) { l = null; }
      if (l) return l;
    }
    return inp.closest('label');
  };
  const optionTextOf = (inp) => {
    const lab = labelFor(inp);
    if (lab) { const t = elText(lab); if (t) return t; }
    for (const c of [inp.getAttribute('aria-label'), inp.getAttribute('title')]) {
      const t = norm(c);
      if (t) return t;
    }
    const p = inp.parentElement;
    if (p) { const t = elText(p); if (t && t.length < 300) return t; }
    return norm(inp.value);
  };
  const LETTER_RE = /^([A-Ha-h])[\\s\\.、\\)．:：]/;
  const hasInputInside = (el) => !!el.querySelector('input,textarea,select,[contenteditable="true"]');

  // 页面"外壳"（页头、导航、语言切换、工具栏…）里的东西一律不碰
  const CHROME_DEFAULT = 'header,nav,footer,aside,[role="navigation"],[role="banner"],' +
    '[class*="lang"],[class*="locale"],[class*="i18n"],[class*="switch"],[class*="toolbar"],' +
    '[class*="breadcrumb"],[class*="topbar"],[class*="top-bar"],[class*="tabbar"],[class*="tab-bar"]';
  const chromeList = pick('chrome', []);
  const CHROME_SEL = chromeList.length ? chromeList.join(',') : CHROME_DEFAULT;
  const inChrome = (el) => {
    try { return !!el.closest(CHROME_SEL); } catch (e) { return false; }
  };
  const LANG_CLASS = /(^|[\\s_-])(lang|language|locale|i18n|switch)([\\s_-]|$)/i;
  // 语言切换控件：在语言容器里，或自身/祖先带 lang/switch 类名
  const isLangish = (el) => {
    if (!el) return false;
    if (inChrome(el)) return true;
    let n = el;
    for (let i = 0; n && i < 4; i += 1) {
      const cls = n.className && typeof n.className === 'string' ? n.className : '';
      if (LANG_CLASS.test(cls) || LANG_CLASS.test(n.id || '')) return true;
      n = n.parentElement;
    }
    return false;
  };
  // “语言切换”类文案，即使不在 header 里也不点
  const LANG_TEXT = /^(语言|語言|切换语言|language|language settings|中文|简体中文|繁體中文|繁体中文|English|EN|EN-US|日本語|한국어|Español|Français|Deutsch|Русский)$/i;
  const ignoreText = (cfg.agent && cfg.agent.ignoreTextRegex) ? new RegExp(cfg.agent.ignoreTextRegex, 'i') : null;

  // ---------- 找当前题的题干 ----------
  const titleSel = pick('question', []).filter(Boolean);
  const allTitles = [];
  for (const s of titleSel) {
    let list = [];
    try { list = Array.from(document.querySelectorAll(s)); } catch (e) { continue; }
    for (const el of list) {
      if (!visible(el) || hasInputInside(el)) continue;
      if (elText(el).length < 4) continue;
      if (!allTitles.includes(el)) allTitles.push(el);
    }
  }

  let stemEl = null;
  if (allTitles.length === 1) {
    stemEl = allTitles[0];
  } else if (allTitles.length > 1) {
    // 一页多题：取离视口中心最近的那道
    const center = window.innerHeight / 2;
    let best = Infinity;
    for (const el of allTitles) {
      const r = el.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - center);
      if (d < best) { best = d; stemEl = el; }
    }
  }

  // 题干所在区块：向外扩到“再扩就会包含别的题干”的上一层为止
  let scope = document.body;
  if (stemEl) {
    let node = stemEl;
    for (let up = 0; node && node.parentElement && node.parentElement !== document.body; up += 1) {
      const p = node.parentElement;
      if (allTitles.some((c) => c !== stemEl && p.contains(c))) break;
      node = p;
    }
    scope = node;
  }

  // ---------- 选项 ----------
  // 语言切换、页头导航里的控件不算选项
  const inputs = Array.from(scope.querySelectorAll('input[type=radio], input[type=checkbox]'))
    .filter((el) => !el.disabled && el.isConnected && !isLangish(el));
  const radios = inputs.filter((i) => i.type === 'radio');
  const checks = inputs.filter((i) => i.type === 'checkbox');

  let kind = 'unknown';
  let optEls = [];
  if (radios.length >= 2) { kind = 'single'; optEls = radios; }
  else if (checks.length >= 2) { kind = 'multiple'; optEls = checks; }
  else if (checks.length === 1 && radios.length === 0) { kind = 'single'; optEls = checks; }

  // 兜底：可点击的 div 选项。排除“容器”（内部还有按钮的）和语言切换
  const NESTED_CLICKABLE = 'button,a,[role="button"],input,[class*="btn"]';
  const isWrapper = (el) => {
    try { return !!el.querySelector(NESTED_CLICKABLE); } catch (e) { return false; }
  };
  if (!optEls.length) {
    for (const s of pick('optionLike', [])) {
      let list = [];
      try { list = Array.from(scope.querySelectorAll(s)); } catch (e) { continue; }
      list = list.filter(visible)
        .filter((el) => { const t = elText(el); return t.length > 0 && t.length < 200; })
        .filter((el) => !isWrapper(el) && !isLangish(el) && !LANG_TEXT.test(elText(el)))
        // 去掉“包住别的选项”的外层容器，只留最内层的选项
        .filter((el) => !list.some((other) => other !== el && el.contains(other)));
      if (list.length >= 2 && list.length <= 12) { optEls = list; kind = 'single'; break; }
    }
  }

  // 选项文字太短（只有一个字母/标点）时，补上 title / aria-label / 相邻文字，
  // 否则模型只看到 "A" "B" 根本判断不了对错
  const extraDesc = (el) => {
    const parts = [];
    for (const a of ['title', 'aria-label', 'data-label', 'data-text', 'data-value', 'alt']) {
      const v = norm(el.getAttribute && el.getAttribute(a));
      if (v && v.length <= 30) parts.push(v);
    }
    return norm(Array.from(new Set(parts)).join(' '));
  };
  // 只有“光秃秃一个字母/符号”的选项才需要补语义，避免把相邻选项的文字拼进来
  const BARE = /^([A-Ha-h]|\\d{1,2}|对|错|是|否|T|F)$/;

  const options = optEls.map((el, idx) => {
    const isInput = el.tagName === 'INPUT';
    const raw = isInput ? optionTextOf(el) : elText(el);
    let m = raw.match(LETTER_RE);
    let head = m;
    // "A正确" 这种字母紧贴文字、没有分隔符的写法
    if (!m && !isInput && raw.length <= 8) {
      const m2 = raw.match(/^([A-Ha-h])[\\s:：.、]?(.{1,12})$/);
      if (m2 && norm(m2[2])) { head = m2; m = m2; }
    }
    const lab = isInput ? labelFor(el) : null;
    let text = m ? norm(raw.slice(m[0].length)) : raw;
    // 文字只有一个字母时，用 title / aria-label 补语义（"A" -> "A 正确"）
    if (BARE.test(text)) {
      const desc = isInput ? '' : extraDesc(el);
      if (desc && !text.includes(desc)) text = norm(text + ' ' + desc);
    }
    return {
      key: head ? head[1].toUpperCase() : String.fromCharCode(65 + idx),
      index: idx,
      raw,
      text,
      inputSel: isInput ? stamp(el, 'i' + idx) : null,
      clickSel: isInput ? (lab && visible(lab) ? stamp(lab, 'l' + idx) : null) : stamp(el, 'l' + idx),
      checked: isCheckedEl(el),
      name: el.name || '',
    };
  });

  // ---------- 填空 ----------
  const blankEls = [];
  for (const s of pick('blankInput', [])) {
    let list = [];
    try { list = Array.from(scope.querySelectorAll(s)); } catch (e) { continue; }
    for (const el of list) {
      if (!visible(el) || el.disabled || el.readOnly) continue;
      if (blankEls.includes(el)) continue;
      blankEls.push(el);
    }
  }
  const blanks = blankEls.slice(0, 8).map((el, idx) => ({
    index: idx,
    target: stamp(el, 'b' + idx),
    value: el.value !== undefined ? el.value : elText(el),
    placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
    tag: el.tagName.toLowerCase(),
  }));

  // ---------- 下拉 ----------
  const selects = Array.from(scope.querySelectorAll('select')).filter(visible).slice(0, 3).map((el, idx) => ({
    index: idx,
    target: stamp(el, 's' + idx),
    value: el.value,
    options: Array.from(el.options).map((o) => ({ value: o.value, text: norm(o.textContent) })),
  }));

  if (kind === 'unknown') {
    if (selects.length) kind = 'select';
    else if (blanks.length) kind = 'blank';
  }

  let stem = stemEl ? elText(stemEl) : '';
  // 兜底：取选项的公共祖先，去掉选项文字和按钮文字
  if (!stem && options.length) {
    let node = optEls[0];
    for (let up = 0; node && up < 6; up += 1) {
      node = node.parentElement;
      if (!node) break;
      let t = elText(node);
      for (const o of options) if (o.raw) t = t.split(o.raw).join(' ');
      for (const b of Array.from(node.querySelectorAll('button,a[role=button]'))) t = t.split(elText(b)).join(' ');
      t = norm(t);
      if (t.length >= 4 && t.length < 1200) { stem = t; break; }
    }
  }

  // ---------- 进度提示 ----------
  let hint = '';
  const bodyText = document.body ? document.body.innerText : '';
  const hm = bodyText.match(/第\\s*\\d+\\s*[题題]|[（(]\\s*\\d+\\s*\\/\\s*\\d+\\s*[)）]/m);
  if (hm) hint = norm(hm[0]);

  // ---------- 结果区 ----------
  let hasResult = false;
  let resultText = '';
  for (const s of pick('result', [])) {
    let list = [];
    try { list = Array.from(document.querySelectorAll(s)); } catch (e) { continue; }
    for (const el of list) {
      if (!visible(el)) continue;
      const t = elText(el);
      if (t) { hasResult = true; resultText = t.slice(0, 300); break; }
    }
    if (hasResult) break;
  }

  // ---------- 按钮 ----------
  const btnText = (el) => norm(el.innerText || el.value || el.getAttribute('aria-label') || '');
  // 只保留“题干区块内 / 非页面外壳 / 非语言切换”的控件
  const ignorable = (el) => inChrome(el) || LANG_TEXT.test(btnText(el)) || (ignoreText ? ignoreText.test(btnText(el)) : false);
  // 去掉空格再匹配：有的站点把“提 交”用 letter-spacing 拆开
  const flat = (s) => String(s || '').replace(/\s+/g, '');
  const clickables = Array.from(document.querySelectorAll('button, a, [role="button"], input[type=submit], input[type=button], div[class*="btn"], span[class*="btn"]'))
    .filter((el) => visible(el) && !el.disabled)
    .filter((el) => !ignorable(el))
    // 排除“按钮组容器”：它的文案是 上一题下一题提交 拼起来的
    .filter((el) => !isWrapper(el));
  const findBySel = (sels) => {
    for (const s of sels || []) {
      let list = [];
      try { list = Array.from(document.querySelectorAll(s)); } catch (e) { continue; }
      const hit = list.find((el) => visible(el) && !el.disabled && !ignorable(el));
      if (hit) return hit;
    }
    return null;
  };
  // 优先题干所在区块里的按钮；没有再退回整页候选
  const inStemScope = (el) => scope !== document.body && scope.contains(el);
  const preferScoped = (list) => list.find(inStemScope) || list[0] || null;
  const submitRe = new RegExp(cfg.submitTextRegex || '提交|交卷', 'i');
  const nextRe = new RegExp(cfg.nextTextRegex || '下一题|Next', 'i');
  const bySelSubmit = findBySel(pick('submitButton', []));
  const bySelNext = findBySel(pick('nextButton', []));
  const submitEl = bySelSubmit || preferScoped(clickables.filter((el) => submitRe.test(flat(btnText(el)))));
  let nextEl = bySelNext;
  if (!nextEl) {
    const list = clickables.filter((el) => nextRe.test(flat(btnText(el))) && el !== submitEl && !submitRe.test(flat(btnText(el))));
    nextEl = preferScoped(list);
  }
  if (nextEl && submitEl && nextEl === submitEl) nextEl = null;

  return {
    url: location.href,
    title: document.title,
    hint,
    stem,
    contextText: norm(bodyText).slice(0, 3000),
    kind,
    options: options.slice(0, 12),
    blanks,
    selects,
    nextTarget: nextEl ? stamp(nextEl, 'n') : null,
    nextText: nextEl ? btnText(nextEl) : '',
    nextInScope: nextEl ? inStemScope(nextEl) : false,
    submitTarget: submitEl ? stamp(submitEl, 'u') : null,
    submitText: submitEl ? btnText(submitEl) : '',
    submitInScope: submitEl ? inStemScope(submitEl) : false,
    hasResult,
    resultText,
    counts: { radios: radios.length, checks: checks.length, blanks: blanks.length, selects: selects.length },
    stemCount: allTitles.length,
  };
}
`;

let seq = 0;

/** 提取当前页面的题目。page 为 Playwright Page。 */
export async function extractQuestion(page, cfg) {
  seq += 1;
  const prefix = `p${seq}_`;
  return page.evaluate(`(${PAGE_FN})(${JSON.stringify(cfg)}, ${JSON.stringify(prefix)})`);
}
