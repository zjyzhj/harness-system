/* 模型用量：按天、按模型汇总（每轮所有调用都算，含推理预想 / 自检 / 压缩），保留 90 天 */
import { readJsonSafe, writeJsonAtomic } from "../../core/atomic-fs";

export type UsageRow = { input: number; output: number; calls: number; turns: number; cached?: number };
type UsageBook = { days: Record<string, Record<string, UsageRow>> };
export type UsageEvent = { providerId: string; model?: string; input: number; output: number; calls: number; cached?: number };

const localDay = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export function createUsageBook(file: string, providerName: (id: string) => string | undefined) {
  const record = (u: UsageEvent) => {
    try {
      const book = readJsonSafe<UsageBook>(file, { days: {} });
      const day = (book.days[localDay()] ??= {});
      const key = `${providerName(u.providerId) ?? u.providerId} · ${u.model ?? "默认模型"}`;
      const row = (day[key] ??= { input: 0, output: 0, calls: 0, turns: 0 });
      row.input += u.input; row.output += u.output; row.calls += u.calls; row.turns += 1; row.cached = (row.cached ?? 0) + (u.cached ?? 0);
      const keep = Object.keys(book.days).sort().slice(-90);
      book.days = Object.fromEntries(keep.map((k) => [k, book.days[k]]));
      writeJsonAtomic(file, book);
    } catch (e) { console.error("[usage] 记录失败", e); }
  };
  const summary = () => {
    const book = readJsonSafe<UsageBook>(file, { days: {} });
    const sum = (days: string[]) => {
      const rows: Record<string, UsageRow> = {};
      for (const d of days) for (const [k, r] of Object.entries(book.days[d] ?? {})) {
        const x = (rows[k] ??= { input: 0, output: 0, calls: 0, turns: 0, cached: 0 });
        x.input += r.input; x.output += r.output; x.calls += r.calls; x.turns += r.turns; x.cached = (x.cached ?? 0) + (r.cached ?? 0);
      }
      return rows;
    };
    const today = localDay();
    const month = today.slice(0, 7);
    return { today: sum([today]), month: sum(Object.keys(book.days).filter((d) => d.startsWith(month))) };
  };
  return { record, summary };
}
