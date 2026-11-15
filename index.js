import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'

// stall-watchdog: when one tool call runs longer than a threshold, inject a
// self-check reminder into the owning agent so the model notices the stall
// instead of silently waiting forever.
//
// Every user-tunable value lives in `Config` and is declared `.volatile()`, so
// it shows up under the plugin's Settings card and changes take effect without
// a restart. A volatile field arrives here as a stable reference; we read it
// with `.get()` at the moment each tool call starts, so the next call picks up
// whatever value the user just set.

/** Producer-owned source kind. Session V4 rejects a bare 'plugin' literal. */
const SOURCE_KIND = 'plugin:stall-watchdog'

export const name = 'stall-watchdog'

/** The event this plugin observes is dispatched by the tools service. */
export const inject = ['tools']

// Defaults are the source of truth; the patch config can override them.
// Time fields are in SECONDS — the Settings form shows and edits them directly.
export const Config = Schema.object({
  enabled: Schema
    .boolean()
    .default(true)
    .volatile()
    .description('开关：是否监控工具调用超时。关闭后本插件不再注入任何提醒。'),
  stallSec: Schema
    .number()
    .step(1)
    .min(1)
    .default(600)
    .volatile()
    .description('超时阈值（秒）：单个工具调用运行超过这个时长仍未返回，就向模型注入一条自查提醒。默认 600 秒（10 分钟）。'),
  repeatSec: Schema
    .number()
    .step(1)
    .min(0)
    .default(0)
    .volatile()
    .description('重复提醒间隔（秒）：同一个调用一直不返回时，每隔这个时长再提醒一次；填 0 表示每次调用只提醒一次。'),
  maxReminders: Schema
    .number()
    .step(1)
    .min(1)
    .default(3)
    .volatile()
    .description('一次调用最多提醒几次（仅在重复间隔大于 0 时生效）。'),
  excludeTools: Schema
    .array(Schema.string())
    .default([])
    .volatile()
    .description('不监控的工具名列表：后台任务类工具本就应长时间运行，列在这里可避免误报。'),
  message: Schema
    .string()
    .default('')
    .volatile()
    .description('自定义提醒文案，留空则用内置中文文案。可用占位符 {tool} {elapsed} {threshold} {attempt}。'),
})

/** A volatile field is a stable ref with .get(); unwrap it, else use as-is. */
function val(ref, fallback) {
  const v = ref !== null && typeof ref === 'object' && typeof ref.get === 'function' ? ref.get() : ref
  if (v === null || v === undefined) return fallback
  return v
}

/** Read a numeric field with a floor; fall back on anything non-numeric. */
function num(ref, fallback, min) {
  const v = val(ref, undefined)
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= min ? Math.floor(n) : fallback
}

// A nested call (a parent tool that itself dispatches sub-tools, e.g. run_code)
// is already timed by its own dispatch; timing it again would double-report.
function isRootCall(exec) {
  return exec.rootCallId === undefined || exec.rootCallId === exec.callId
}

function formatDuration(ms) {
  const total = Math.max(1, Math.round(ms / 1000))
  if (total < 60) return `${total} 秒`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s === 0 ? `${m} 分钟` : `${m} 分 ${s} 秒`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm === 0 ? `${h} 小时` : `${h} 小时 ${rm} 分`
}

function reminderText(exec, elapsedMs, attempt, cfg) {
  const threshold = formatDuration(cfg.stallMs)
  const elapsed = formatDuration(elapsedMs)
  if (cfg.message !== undefined) {
    return cfg.message
      .split('{tool}').join(exec.name)
      .split('{elapsed}').join(elapsed)
      .split('{threshold}').join(threshold)
      .split('{attempt}').join(String(attempt))
  }
  const lines = [
    `[stall-watchdog] 工具调用 \`${exec.name}\` 已运行 ${elapsed} 仍未返回（阈值 ${threshold}）。`,
    '请自查这一步是否真的卡住：',
    '- 是否在等待交互输入（提示符 / 分页器 / 密码 / y-n 确认）；',
    '- 是否卡在网络下载、构建、索引或死循环上；',
    '- 是否应拆成更小步骤、加超时参数、或改用不阻塞的方式。',
    '若确认卡住：中止该调用并换方案，不要让同一个调用无限等待。',
    '若确属长耗时：把预计耗时与当前在等什么告诉用户。',
  ]
  if (attempt > 1) lines.push(`（这是第 ${attempt} 次提醒；该调用仍未返回。）`)
  return lines.join('\n')
}

/**
 * Deliver the reminder. A running agent cannot be woken by `inject`, but the
 * message lands in the next admitted step — exactly where the model is when the
 * long call finally returns. If the agent already went idle, `followup` wakes it.
 */
function remind(ctx, agent, exec, elapsedMs, attempt, cfg) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: reminderText(exec, elapsedMs, attempt, cfg) }],
    source: { kind: SOURCE_KIND },
  }
  try {
    if (agent.status === 'idle') agent.followup(message)
    else agent.inject(message)
  } catch {
    try {
      agent.inject(message)
    } catch {
      // Agent already disposed; there is nothing left to notify.
      return
    }
  }
  try {
    ctx.logger?.warn?.(`stall-watchdog: \`${exec.name}\` 运行 ${formatDuration(elapsedMs)}，已提醒 ${agent.id}`)
  } catch {
    // Logging must never break dispatch.
  }
}

export function apply(ctx, config) {
  // Cleanup handles for every in-flight dispatch, so unload disarms all clocks.
  const pending = new Set()
  ctx.effect(() => {
    for (const disarm of [...pending]) {
      try {
        disarm()
      } catch {
        // Keep cleaning the rest.
      }
    }
    pending.clear()
  })

  ctx.on('tools/execute', async (exec, next) => {
    // Read the live values at the moment this call starts, so a Settings edit
    // applies to the very next call without restarting the plugin.
    if (val(config.enabled, true) === false) return next()
    if (!isRootCall(exec)) return next()
    const agent = exec.agent
    if (agent === undefined) return next()
    const exclude = val(config.excludeTools, [])
    if (Array.isArray(exclude) && exclude.includes(exec.name)) return next()

    const cfg = {
      stallMs: num(config.stallSec, 600, 1) * 1000,
      repeatMs: num(config.repeatSec, 0, 0) * 1000,
      maxReminders: num(config.maxReminders, 3, 1),
      message: (() => {
        const m = val(config.message, '')
        return typeof m === 'string' && m.length > 0 ? m : undefined
      })(),
    }

    const startedAt = Date.now()
    let fired = 0
    let timer = undefined
    let closed = false

    const disarm = () => {
      closed = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      pending.delete(disarm)
    }

    const arm = (delayMs) => {
      if (closed) return
      timer = setTimeout(() => {
        timer = undefined
        if (closed) return
        fired += 1
        remind(ctx, agent, exec, Date.now() - startedAt, fired, cfg)
        if (cfg.repeatMs > 0 && fired < cfg.maxReminders) arm(cfg.repeatMs)
      }, delayMs)
      if (typeof timer.unref === 'function') timer.unref()
    }

    pending.add(disarm)
    arm(cfg.stallMs)

    try {
      return await next()
    } finally {
      disarm()
    }
  })
}
