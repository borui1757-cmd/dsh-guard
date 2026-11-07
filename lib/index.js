// index.js —— dsh-guard 插件入口
//
// 四个工具：check / snapshot / verify / restore
// 原则：动手前先备份；坏了能补齐；补不回来要明说。
import { checkInstance, snapshot, verifySession, guardAndRestore, listSnapshots, restore } from './guard.js';

let defineTool = null;
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
}
catch {
  defineTool = null;
}

export const name = 'dsh-guard';
export const inject = ['tools'];

export function apply(ctx, config = {}) {
  if (!defineTool) return;
  const tools = (ctx && ctx.tools) || (typeof ctx.get === 'function' ? ctx.get('tools') : null);
  if (!tools || typeof tools.register !== 'function') return;

  const port = Number.isInteger(config.port) ? config.port : 3080;

  // ① 单实例检查
  tools.register(defineTool({
    name: 'guard_check',
    description: '检查同一 profile 是否已有宿主在跑（端口占用）。有就别再起第二个：两个进程会互相覆盖会话写入（实测丢 72%）。',
    parameters: {
      port: { type: 'number', description: `宿主端口，默认 ${port}` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          port: { type: 'integer', required: true },
          busy: { type: 'boolean', required: true },
          advice: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: `${v.busy ? '占用' : '空闲'} :${v.port}\n${v.advice || ''}` }],
    },
    async execute(args) {
      const r = await checkInstance(args?.port || port);
      return { ok: r.ok, port: r.port, busy: r.busy, advice: r.advice };
    },
  }));

  // ② 动手前备份
  tools.register(defineTool({
    name: 'guard_snapshot',
    description: '给文件做滚动备份（默认保留最近 3 份）。改会话/清理数据之前先跑一次。',
    parameters: {
      file: { type: 'string', required: true, description: '要备份的文件绝对路径' },
      keep: { type: 'number', description: '保留几份，默认 3' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          snapshot: { type: 'string' },
          size: { type: 'integer' },
          pruned: { type: 'integer' },
          reason: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? `已备份 → ${v.snapshot}（${v.size} B，清理 ${v.pruned} 份旧备份）` : `备份失败：${v.reason}` }],
    },
    execute(args) {
      const r = snapshot(String(args?.file || ''), { keep: args?.keep });
      return Promise.resolve(r.ok ? { ok: true, snapshot: r.snapshot, size: r.size, pruned: r.pruned } : { ok: false, reason: r.reason });
    },
  }));

  // ③ 结构体检
  tools.register(defineTool({
    name: 'guard_verify',
    description: '会话结构体检：能否解压、工具调用/结果是否配对完整。返回悬空调用位置。',
    parameters: {
      file: { type: 'string', required: true, description: '会话文件路径' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          events: { type: 'integer' },
          violations: { type: 'integer' },
          reason: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? `结构干净（${v.events} 事件，0 悬空）` : `有问题：${v.reason || `${v.violations} 处悬空`}` }],
    },
    execute(args) {
      const r = verifySession(String(args?.file || ''));
      return Promise.resolve({
        ok: r.ok,
        ...(typeof r.events === 'number' ? { events: r.events } : {}),
        ...(Array.isArray(r.violations) ? { violations: r.violations.length } : {}),
        ...(r.reason ? { reason: r.reason } : {}),
      });
    },
  }));

  // ④ 坏了就补齐
  tools.register(defineTool({
    name: 'guard_restore',
    description: '体检不合格时，从最近一个合格快照恢复（恢复前会把当前状态再备份一份，避免越救越糟）。',
    parameters: {
      file: { type: 'string', required: true, description: '会话文件路径' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          from: { type: 'string' },
          preRestoreBackup: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.ok ? `已从快照恢复：${v.from}\n恢复前状态：${v.preRestoreBackup || '(无)'}` : `恢复失败：${v.reason}` }],
    },
    async execute(args) {
      const file = String(args?.file || '');
      const r = guardAndRestore(file);
      if (r.ok && r.restored) return { ok: true, from: r.restored.from, preRestoreBackup: r.restored.preRestoreBackup };
      if (r.ok) return { ok: true, preRestoreBackup: '' };
      return { ok: false, reason: r.reason || '没有可用快照' };
    },
  }));
}

export { checkInstance, snapshot, verifySession, listSnapshots, restore };
