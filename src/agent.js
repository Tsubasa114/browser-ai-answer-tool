// 主循环：读题 -> 求答案 -> 填/点 -> 下一题 -> 直到交卷或题目结束
import path from 'node:path';
import { extractQuestion } from './extract.js';
import { applyDecision, advance, waitForAdvance, signature } from './act.js';
import { record, ensureDir, info, warn, error } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readQuestion(page, cfg, attempts = 4) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await extractQuestion(page, cfg).catch((e) => null);
    if (last && (last.stem || last.kind !== 'unknown') && !last.hasResult) return last;
    if (last && last.hasResult) return last;
    await sleep(400);
  }
  return last;
}

export async function runAgent(page, cfg, solver, opts = {}) {
  const stats = { ok: 0, skipped: 0, total: 0, submitted: false, reason: '', score: '' };
  const records = [];
  let prevSig = '';
  let stall = 0;
  let current = page;
  let switched = 0;

  // 题目可能开在新标签页：当前页读不到题时，重新扫描一次并切过去
  const tryReacquire = async () => {
    if (typeof opts.reacquire !== 'function' || switched >= 2) return false;
    switched += 1;
    const next = await opts.reacquire(current).catch(() => null);
    if (next && next !== current) {
      current = next;
      prevSig = '';
      stall = 0;
      info(`已切换标签页：${current.url()}`);
      return true;
    }
    return false;
  };

  const pushRecord = (rec) => {
    records.push(rec);
    try { record(cfg.agent.recordFile, rec); } catch (e) {}
    if (typeof opts.onRecord === 'function') {
      try { opts.onRecord(rec, stats); } catch (e) {}
    }
  };

  // 作答后很多站点会重渲染（按钮节点被替换），导航前重新取一次定位
  const refreshTargets = async (q) => {
    const fresh = await extractQuestion(current, cfg).catch(() => null);
    if (!fresh || fresh.hasResult) return q;
    if (!fresh.nextTarget && !fresh.submitTarget) return q;
    return fresh;
  };

  for (let i = 0; i < (cfg.agent.maxQuestions || 300); i += 1) {
    if (typeof opts.shouldStop === 'function' && opts.shouldStop()) {
      stats.reason = '已手动停止';
      info('收到停止指令，结束本轮');
      break;
    }
    const q = await readQuestion(current, cfg);
    if (!q) {
      if (await tryReacquire()) continue;
      stats.reason = '页面读取失败';
      break;
    }

    if (q.hasResult) {
      stats.score = q.resultText;
      stats.reason = '检测到结果页';
      info(`已到结果页：${q.resultText.slice(0, 80)}`);
      break;
    }
    if (q.kind === 'unknown' && !q.stem) {
      if (await tryReacquire()) continue;
      stats.reason = '提取不到题目（没有题干也没有可答控件）';
      warn(stats.reason + '，可能需要在 config 里补 selectors');
      break;
    }
    const sig = signature(q);
    if (sig === prevSig) {
      stall += 1;
      if (stall >= 2) { stats.reason = '题目没有变化（可能点了没反应，或已到最后一题）'; warn(stats.reason); break; }
      await sleep(600);
      continue;
    }
    prevSig = sig;
    stall = 0;
    stats.total += 1;

    info(`[第 ${stats.total} 题] ${q.kind} | ${q.hint || ''} ${q.stem.slice(0, 60)}`);
    if (q.options.length) info('  选项：' + q.options.map((o) => `${o.key}.${o.text.slice(0, 12)}`).join(' | '));

    let decision;
    try {
      decision = await solver.solve(q);
    } catch (e) {
      error(`作答失败：${e.message}`);
      stats.skipped += 1;
      stats.reason = `模型调用失败：${e.message}`;
      break;
    }

    const conf = decision.confidence ?? 0;
    const hasAnswer = (decision.keys && decision.keys.length) || (decision.value && String(decision.value).trim());
    const recBase = {
      at: new Date().toISOString(),
      index: stats.total,
      kind: q.kind,
      hint: q.hint,
      stem: q.stem,
      options: q.options.map((o) => `${o.key}.${o.text}`),
      answer: decision.keys || decision.value || null,
      confidence: conf,
      reason: decision.reason || '',
      model: solver.name,
      url: q.url,
    };

    if (!hasAnswer) {
      recBase.applied = false;
      recBase.detail = '模型未给出可用答案';
      stats.skipped += 1;
      pushRecord(recBase);
      if (cfg.agent.pauseOnLowConfidence) { stats.reason = '无答案且开启了人工接管'; break; }
      if (q.submitTarget) { stats.reason = '当前是最后一题但没有答案，为避免交半张卷已停止'; break; }
      warn('没有可用答案，跳过该题');
      const act = await advance(current, await refreshTargets(q), cfg, { index: stats.total });
      if (act.action === 'none') { stats.reason = '试过按钮/题号/URL/键盘/滚动，都没能跳到下一题'; break; }
      if (act.action === 'submit') { stats.submitted = true; await waitForAdvance(current, q, cfg, extractQuestion); break; }
      const w = await waitForAdvance(current, q, cfg, extractQuestion);
      if (!w.advanced) { stats.reason = '点击后题目未推进'; break; }
      continue;
    }

    if (conf < (cfg.agent.confidenceThreshold ?? 0.35)) {
      warn(`置信度较低 (${conf.toFixed(2)})：${decision.reason || ''}`);
      if (cfg.agent.pauseOnLowConfidence && !cfg.agent.dryRun) {
        recBase.applied = false;
        recBase.detail = '低置信度，等待人工处理';
        pushRecord(recBase);
        stats.reason = '低置信度暂停';
        break;
      }
    }

    if (cfg.agent.dryRun) {
      info('  [dry-run] 只识别不操作，答案：' + JSON.stringify(decision.keys || decision.value));
      recBase.applied = false;
      recBase.detail = 'dry-run';
      pushRecord(recBase);
      if (q.submitTarget) { stats.reason = 'dry-run：已到最后一题，不点提交'; break; }
      const act = await advance(current, await refreshTargets(q), cfg, { index: stats.total });
      if (act.action === 'none') { stats.reason = '试过按钮/题号/URL/键盘/滚动，都没能跳到下一题'; break; }
      const w = await waitForAdvance(current, q, cfg, extractQuestion);
      if (!w.advanced) { stats.reason = '点击后题目未推进'; break; }
      continue;
    }

    const res = await applyDecision(current, q, decision, cfg);
    recBase.applied = res.applied;
    recBase.detail = res.detail;
    if (res.applied) stats.ok += 1;
    pushRecord(recBase);
    if (!res.applied) warn(`答案落页失败：${res.detail}`);
    info(`  作答：${JSON.stringify(decision.keys || decision.value)}  ${res.detail}`);

    await sleep(cfg.agent.delayMs ?? 700);

    const act = await advance(current, await refreshTargets(q), cfg, { index: stats.total });
    if (act.action === 'none') {
      stats.reason = '试过按钮/题号/URL/键盘/滚动，都没能跳到下一题';
      warn(stats.reason + '（可用 selectors.nextButton 或 agent.nextStrategies 调整）');
      break;
    }
    const w = await waitForAdvance(current, q, cfg, extractQuestion);
    if (act.action === 'submit') {
      stats.submitted = true;
      if (w.cur && w.cur.hasResult) stats.score = w.cur.resultText;
      if (!w.advanced) info('已点击提交，等待结果…');
      break;
    }
    if (!w.advanced) {
      stats.reason = '点击下一题后页面没有推进';
      warn(stats.reason);
      break;
    }
  }

  if (!stats.reason) stats.reason = stats.submitted ? '已提交' : '达到题目上限';
  return stats;
}

/** 兜底：整页截图存盘，便于人工复核或在 config 里对比选择器 */
export async function snapshot(page, cfg, tag) {
  const dir = ensureDir(cfg.agent.screenshotDir || 'runs/shots');
  const file = path.join(dir, `${tag}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}
