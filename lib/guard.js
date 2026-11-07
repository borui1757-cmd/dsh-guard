// guard.js —— 危险区守卫：先备份，再动手；出问题能补齐。
//
// 三类危险：
//   ① 同 profile 起第二个宿主 → 两个进程读-改-写同一会话（实测丢 72% 写入）
//   ② 直接改会话文件（手术/清理）→ 改错了没有退路
//   ③ 磁盘上的坏结构 → 打开就 400
//
// 所以：动手前 check + snapshot，动完 verify，坏了 restore。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';

/** 端口上是否已经有人在听（= 已有宿主在跑） */
export function portBusy(port = 3080, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    s.connect(port, host);
  });
}

/** 检查是否已有宿主；返回给人看的结论 */
export async function checkInstance(port = 3080) {
  const busy = await portBusy(port);
  return {
    port,
    busy,
    ok: !busy,
    advice: busy
      ? `:${port} 已被占用——已有宿主在跑。禁止再起第二个（同一 profile 会互相覆盖写入）。`
      : `:${port} 空闲，可以启动。`,
  };
}

/** 滚动备份：file → file.bak-<ts>，只保留最近 keep 份 */
export function snapshot(file, opts = {}) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return { ok: false, reason: '文件不存在', file: abs };

  const keep = Number.isInteger(opts.keep) ? opts.keep : 3;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = `${abs}.bak-${ts}`;
  fs.copyFileSync(abs, dst);

  // 清理旧备份（只删我们自己造的 .bak-<iso> 形式）
  const dir = path.dirname(abs);
  const base = path.basename(abs) + '.bak-';
  const olds = fs.readdirSync(dir)
    .filter((f) => f.startsWith(base))
    .sort()
    .slice(0, Math.max(0, fs.readdirSync(dir).filter((f) => f.startsWith(base)).length - keep));
  for (const f of olds) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* 删不掉就算了 */ }
  }

  return { ok: true, file: abs, snapshot: dst, size: fs.statSync(dst).size, pruned: olds.length };
}

export function listSnapshots(file) {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const base = path.basename(abs) + '.bak-';
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort().map((f) => path.join(dir, f));
}

/** 从快照恢复（恢复前先把当前状态也备份一份，避免越救越糟） */
export function restore(file, which = 'latest') {
  const abs = path.resolve(file);
  const snaps = listSnapshots(abs);
  if (!snaps.length) return { ok: false, reason: '没有可用快照' };

  const src = which === 'latest' ? snaps[snaps.length - 1] : snaps.find((s) => s.endsWith(which));
  if (!src) return { ok: false, reason: `找不到快照 ${which}` };

  let pre = null;
  if (fs.existsSync(abs)) {
    pre = `${abs}.pre-restore-${Date.now()}`;
    fs.copyFileSync(abs, pre);
  }
  fs.copyFileSync(src, abs);
  return { ok: true, file: abs, from: src, preRestoreBackup: pre };
}

/** 结构体检：能解压 + 工具调用/结果配对完整 */
export function verifySession(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return { ok: false, reason: '文件不存在' };
  let events;
  try {
    const raw = fs.readFileSync(abs);
    // 按魔数判断是不是 zstd，不能看扩展名——
    // 快照名是 xxx.zstd.bak-<ts>，endsWith('.zstd') 是 false，会把它当纯文本读。
    const isZstd = raw.length >= 4 && raw[0] === 0x28 && raw[1] === 0xB5 && raw[2] === 0x2F && raw[3] === 0xFD;
    const text = isZstd ? zlib.zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8');
    events = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  catch (e) {
    return { ok: false, reason: `解压/解析失败：${String(e.message).slice(0, 120)}` };
  }

  let pending = [];
  const violations = [];
  for (const e of events) {
    if (e.type === 'assistant/message') {
      if (pending.length) { violations.push({ seq: e.seq, missing: [...pending] }); pending = []; }
      for (const b of (e.data?.message?.content ?? []))
        if ((b.type === 'tool-call' || b.type === 'tool_use') && (b.id ?? b.callId)) pending.push(b.id ?? b.callId);
    }
    else if (e.type === 'tool/result') {
      const id = e.data?.message?.toolCallId ?? e.data?.toolCallId ?? e.data?.callId;
      if (id && pending.includes(id)) pending = pending.filter((x) => x !== id);
      else if (pending.length) pending = pending.slice(1);
    }
    else if (e.type === 'user/message') {
      if (pending.length) { violations.push({ seq: e.seq, missing: [...pending] }); pending = []; }
    }
  }
  if (pending.length) violations.push({ seq: '(结尾)', missing: [...pending] });

  return { ok: violations.length === 0, events: events.length, violations };
}

/** 一并做：校验 → 不合格就自动恢复到最近快照 */
export function guardAndRestore(file) {
  const v = verifySession(file);
  if (v.ok) return { ok: true, verified: v, restored: null };
  const snaps = listSnapshots(file);
  if (!snaps.length) return { ok: false, verified: v, restored: null, reason: '结构损坏且没有快照可恢复' };
  // 从最新往回找第一个体检通过的
  for (const s of [...snaps].reverse()) {
    const check = verifySession(s);
    if (check.ok) return { ok: true, verified: v, restored: restore(file, path.basename(s)), fromSnapshot: s };
  }
  return { ok: false, verified: v, restored: null, reason: '所有快照都不合格' };
}

// 供 CLI 兜底：确认路径解析正确再动手
export function assertPath(p) {
  const abs = path.resolve(p);
  if (!abs || abs === path.parse(abs).root) throw new Error(`拒绝操作根目录：${abs}`);
  return abs;
}

export { spawnSync as _spawnSync };
