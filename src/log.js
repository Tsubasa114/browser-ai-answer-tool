// 运行期日志：控制台 + JSONL 记录
import fs from 'node:fs';
import path from 'node:path';

const pad = (n) => String(n).padStart(2, '0');
// 本地时间，面板和终端看起来一致
const ts = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

// 面板订阅日志用：所有日志同时分发给订阅者
const listeners = new Set();
export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function log(level, msg, extra) {
  const line = `[${ts()}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  const tail = extra === undefined ? '' : (typeof extra === 'string' ? ' ' + extra : ' ' + JSON.stringify(extra));
  if (tail) console.log(line, tail);
  else console.log(line);
  if (listeners.size) {
    const event = { level, text: line + tail, time: Date.now() };
    for (const fn of listeners) {
      try { fn(event); } catch (e) {}
    }
  }
}
export const info = (m, e) => log('info', m, e);
export const warn = (m, e) => log('warn', m, e);
export const error = (m, e) => log('error', m, e);

/** 追加一条 JSONL 记录，返回写入的绝对路径 */
export function record(file, obj) {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify(obj) + '\n', 'utf8');
  return abs;
}

export function ensureDir(dir) {
  const abs = path.resolve(dir);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}
