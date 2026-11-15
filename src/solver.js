// 答题决策：组装提示词、调用模型、把输出规整成可执行的答案
import fs from 'node:fs';
import { chat } from './llm.js';

const KIND_LABEL = { single: '单选题', multiple: '多选题', blank: '填空题', select: '下拉选择', unknown: '未知题型' };

export function buildPrompt(q) {
  const lines = [];
  lines.push(`题型：${KIND_LABEL[q.kind] || q.kind}`);
  if (q.hint) lines.push(`进度：${q.hint}`);
  lines.push(`题目：${q.stem || '(题干未识别)'}`);
  if (q.options.length) {
    lines.push('选项：');
    for (const o of q.options) lines.push(`  ${o.key}. ${o.text}`);
  }
  if (q.blanks.length) {
    lines.push(`填空数量：${q.blanks.length}`);
    q.blanks.forEach((b, i) => {
      const ph = b.placeholder ? `（提示：${b.placeholder}）` : '';
      lines.push(`  空 ${i + 1}${ph}`);
    });
  }
  if (q.selects.length) {
    const s = q.selects[0];
    lines.push(`下拉框可选值：${s.options.map((o) => o.text).join(' / ')}`);
  }
  if (q.contextText && q.contextText.length > (q.stem || '').length + 40) {
    lines.push('页面其它文本（可能包含材料题素材，仅供参考）：');
    lines.push(q.contextText.slice(0, 1200));
  }
  return lines.join('\n');
}

const SYSTEM = [
  '你是答题助手，需要给出这道题的正确答案。',
  '只输出一个 JSON 对象，不要输出解释性文字或 Markdown 代码块。',
  '格式：{"answer": ..., "confidence": 0到1的小数, "reason": "20字以内"}',
  'answer 规则：',
  '- 单选题：一个大写字母，例如 "A"',
  '- 多选题：字母数组，例如 ["A","C"]',
  '- 填空题：填写的文本；多个空用 "|" 分隔',
  '- 下拉选择：直接给选项文字',
  '不确定时给出最可能的答案，并把 confidence 压低（低于 0.3）。',
].join('\n');

/** 从模型输出里尽力挖出 JSON */
export function parseJSONLoose(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  try { return JSON.parse(s); } catch (e) {}
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const cut = s.slice(start, end + 1);
    try { return JSON.parse(cut); } catch (e) {}
    // 常见容错：单引号 / 尾逗号
    try {
      const fixed = cut.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"');
      return JSON.parse(fixed);
    } catch (e) {}
  }
  return null;
}

const LETTERS_ONLY = /^[A-Ha-h]{1,6}$/;

/** 把各种形态的 answer 规整成 { keys?, value? } */
export function normalizeAnswer(q, answer) {
  if (answer === undefined || answer === null) return {};
  const validKeys = q.options.map((o) => o.key.toUpperCase());
  const maxKey = validKeys.length ? Math.max(...validKeys.map((k) => k.charCodeAt(0))) : 64;
  const keyFromCode = (n) => String.fromCharCode(64 + n);

  const toKeys = (v) => {
    if (Array.isArray(v)) return v.flatMap((x) => toKeys(x));
    const s = String(v).trim();
    if (!s) return [];
    if (LETTERS_ONLY.test(s)) return s.toUpperCase().split('');
    const parts = s.split(/[\s,，、;；\/|]+/).filter(Boolean);
    if (parts.length > 1) return parts.flatMap((p) => toKeys(p));
    // 只认“纯字母 + 包装”：A / (A) / A. / 选A / 答案：A
    // 注意不能宽松匹配，否则 "False"、"True" 这类单词里的字母会被误当成选项
    const deco = s.match(/^(?:选|答案|选项)?\s*[:：]?\s*[（(]?\s*([A-Ha-h])\s*[)）]?\s*[.。、:：]?$/);
    if (deco) return [deco[1].toUpperCase()];
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (n >= 1 && n <= validKeys.length) return [keyFromCode(n)];
    }
    // 文本匹配选项（判断题里的 "正确"/"错误"、"True"/"False" 走这里）
    const hit = q.options.find((o) => o.text.toLowerCase() === s.toLowerCase()) ||
                q.options.find((o) => s.length >= 2 && (o.text.includes(s) || s.includes(o.text)));
    if (hit) return [hit.key];
    // 最后才退化为“两个字符以内取首字母”
    const letters = s.match(/[A-Ha-h]/g);
    return letters && s.length <= 2 ? [letters[0].toUpperCase()] : [];
  };

  if (q.kind === 'single' || q.kind === 'multiple') {
    let keys = toKeys(answer).filter((k) => validKeys.includes(k));
    keys = Array.from(new Set(keys));
    if (q.kind === 'single') keys = keys.slice(0, 1);
    return { keys };
  }
  if (Array.isArray(answer)) return { value: answer.join(' | ') };
  return { value: String(answer).trim() };
}

export function makeLlmSolver(cfg) {
  return {
    name: `llm:${cfg.llm.model}`,
    async solve(q) {
      const raw = await chat(cfg, [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildPrompt(q) },
      ]);
      const parsed = parseJSONLoose(raw);
      if (!parsed) throw new Error(`模型输出无法解析为 JSON：${String(raw).slice(0, 160)}`);
      const normalized = normalizeAnswer(q, parsed.answer !== undefined ? parsed.answer : parsed.答案);
      const confidence = Number(parsed.confidence ?? parsed.置信度 ?? 0.5);
      return {
        raw,
        ...normalized,
        confidence: Number.isFinite(confidence) ? confidence : 0.5,
        reason: String(parsed.reason || parsed.理由 || '').slice(0, 60),
      };
    },
  };
}

/** 离线/自测用：按题干查固定答案表，模拟一个“什么都会”的模型 */
export function makeMockSolver(fixturesPath) {
  const table = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
  const norm = (s) => String(s || '').replace(/\s+/g, '');
  const entries = Object.entries(table).map(([k, v]) => [norm(k), v]);
  return {
    name: 'mock:fixtures',
    async solve(q) {
      const needle = norm(q.stem);
      let hit = entries.find(([k]) => k === needle);
      if (!hit && needle) hit = entries.find(([k]) => k.length > 4 && (needle.includes(k) || k.includes(needle)));
      if (!hit) return { confidence: 0, reason: '题库里没有这道题' };
      const answer = hit[1];
      const normalized = normalizeAnswer(q, answer);
      return { ...normalized, confidence: 1, reason: 'fixture', raw: JSON.stringify(answer) };
    },
  };
}
