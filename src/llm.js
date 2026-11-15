// 极简 OpenAI 兼容客户端（DeepSeek / OpenAI / Moonshot / 本地 vLLM 都适用）
// 只依赖全局 fetch，无第三方 SDK。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function joinURL(base) {
  return String(base).replace(/\/+$/, '') + '/chat/completions';
}

/**
 * @param {object} cfg 完整配置（用 cfg.llm）
 * @param {Array} messages 标准 messages 数组
 * @param {object} opts { json: boolean, model: string }
 * @returns {Promise<string>} 模型返回的文本
 */
export async function chat(cfg, messages, opts = {}) {
  const llm = cfg.llm;
  if (!llm.apiKey) throw new Error(`缺少 API Key：请设置环境变量 ${llm.apiKeyEnv} 或在配置里填写 llm.apiKey`);
  const url = joinURL(llm.baseURL);
  const body = {
    model: opts.model || llm.model,
    messages,
    temperature: opts.temperature !== undefined ? opts.temperature : llm.temperature,
    stream: false,
  };
  if (opts.json !== false && llm.jsonMode) body.response_format = { type: 'json_object' };

  const maxRetries = llm.maxRetries ?? 2;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), llm.timeoutMs || 60000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const retriable = res.status === 429 || res.status >= 500;
        if (retriable && attempt < maxRetries) {
          await sleep(1200 * (attempt + 1));
          continue;
        }
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = JSON.parse(text);
      const content = data?.choices?.[0]?.message?.content ?? '';
      if (!content) throw new Error('模型返回为空');
      return content;
    } catch (e) {
      lastErr = e;
      const retriable = /aborted|ECONNRESET|ETIMEDOUT|fetch failed|socket/i.test(String(e && e.message));
      if (retriable && attempt < maxRetries) { await sleep(1200 * (attempt + 1)); continue; }
      if (attempt < maxRetries && !/HTTP 4\d\d/.test(String(e.message))) { await sleep(800 * (attempt + 1)); continue; }
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`调用模型失败：${lastErr ? lastErr.message : '未知错误'}`);
}

/** 截图兜底：让视觉模型读图作答（只给建议，不自动点击） */
export async function chatWithImage(cfg, prompt, base64, mime = 'image/png') {
  const model = cfg.llm.visionModel;
  if (!model) throw new Error('未配置 llm.visionModel');
  return chat(cfg, [
    { role: 'system', content: '你在读一张考试/测验网页截图，请按要求作答并只输出 JSON。' },
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
      ],
    },
  ], { json: true, model });
}
