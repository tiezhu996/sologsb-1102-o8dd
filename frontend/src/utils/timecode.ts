/**
 * 时间码工具：秒点与 mm:ss 互转、场次累计时长汇总、时间轴刻度。
 */

/** 秒 → mm:ss（负数按 0 处理） */
export function secondsToTimecode(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const mm = Math.floor(safe / 60);
  const ss = safe % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** mm:ss / m:ss / 纯秒数 → 秒；解析失败返回 NaN */
export function timecodeToSeconds(timecode: string): number {
  const trimmed = timecode.trim();
  if (trimmed === '') return Number.NaN;
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const matched = /^(\d{1,3}):([0-5]?\d)$/.exec(trimmed);
  if (!matched) return Number.NaN;
  return Number.parseInt(matched[1], 10) * 60 + Number.parseInt(matched[2], 10);
}

/** 秒 → 「mm:ss」；超过一小时给出「h:mm:ss」 */
export function secondsToLongTimecode(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(safe / 3600);
  const rest = safe % 3600;
  const mm = Math.floor(rest / 60);
  const ss = rest % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

/** 分钟 → 「X 小时 Y 分钟」 */
export function minutesToReadable(minutes: number): string {
  const safe = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
  if (safe < 60) return `${safe} 分钟`;
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分钟`;
}

/** 场次累计时长汇总（分钟 → 秒） */
export function sumDurationSeconds(durations: ReadonlyArray<number>): number {
  return durations.reduce((acc, cur) => acc + (Number.isFinite(cur) ? Math.max(0, cur) : 0), 0) * 60;
}

/** 相邻场次累计时长：返回每一场「开场秒点」，key 为场次 id */
export function accumulateStartSeconds(
  ordered: ReadonlyArray<{ id: string; durationMin: number }>,
): Record<string, number> {
  const result: Record<string, number> = {};
  let accMin = 0;
  ordered.forEach((scene) => {
    result[scene.id] = accMin * 60;
    accMin += Number.isFinite(scene.durationMin) ? Math.max(0, scene.durationMin) : 0;
  });
  return result;
}

/** 时间轴刻度：按 totalSeconds 生成合理步长的刻度秒点 */
export function buildRulerTicks(totalSeconds: number, maxTicks = 12): number[] {
  const total = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  if (total <= 0) return [0];
  const rawStep = total / Math.max(1, maxTicks);
  const candidates = [5, 10, 15, 30, 60, 90, 120, 180, 300, 600];
  const step = candidates.find((item) => item >= rawStep) ?? 900;
  const ticks: number[] = [];
  for (let t = 0; t <= total; t += step) ticks.push(t);
  if (ticks[ticks.length - 1] !== total) ticks.push(total);
  return ticks;
}

/** 百分比钳制到 0-100 */
export function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** 进度 → 秒点占位（用于时间轴百分比定位） */
export function secondsToPercent(second: number, totalSeconds: number): number {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 0;
  const ratio = (Math.max(0, second) / totalSeconds) * 100;
  return Math.min(100, Math.max(0, ratio));
}
