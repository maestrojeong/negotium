const FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

interface ParsedField {
  values: Set<number>;
  wildcard: boolean;
}

export interface ParsedCronExpression {
  minute: ParsedField;
  hour: ParsedField;
  dayOfMonth: ParsedField;
  month: ParsedField;
  dayOfWeek: ParsedField;
}

function parseNumber(raw: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new Error(`invalid cron value: ${raw}`);
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    throw new Error(`cron value ${value} is outside ${min}-${max}`);
  }
  return value;
}

function parseField(raw: string, min: number, max: number, normalize?: (n: number) => number) {
  const values = new Set<number>();
  const wildcard = raw === "*";
  for (const item of raw.split(",")) {
    if (!item) throw new Error("empty cron list item");
    const [base, stepRaw, extra] = item.split("/");
    if (extra !== undefined) throw new Error(`invalid cron step: ${item}`);
    const step = stepRaw === undefined ? 1 : parseNumber(stepRaw, 1, max - min + 1);
    let start: number;
    let end: number;
    if (base === "*") {
      start = min;
      end = max;
    } else if (base.includes("-")) {
      const [startRaw, endRaw, rangeExtra] = base.split("-");
      if (!startRaw || !endRaw || rangeExtra !== undefined) {
        throw new Error(`invalid cron range: ${base}`);
      }
      start = parseNumber(startRaw, min, max);
      end = parseNumber(endRaw, min, max);
      if (end < start) throw new Error(`descending cron range: ${base}`);
    } else {
      start = parseNumber(base, min, max);
      end = stepRaw === undefined ? start : max;
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalize ? normalize(value) : value);
    }
  }
  return { values, wildcard } satisfies ParsedField;
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron expression must have exactly 5 fields");
  const parsed = fields.map((field, index) => {
    const [min, max] = FIELD_RANGES[index]!;
    return parseField(
      field!,
      min,
      max,
      index === 4 ? (value) => (value === 7 ? 0 : value) : undefined,
    );
  });
  return {
    minute: parsed[0]!,
    hour: parsed[1]!,
    dayOfMonth: parsed[2]!,
    month: parsed[3]!,
    dayOfWeek: parsed[4]!,
  };
}

export function validateCronExpression(
  expression: string,
): { ok: true } | { ok: false; error: string } {
  try {
    parseCronExpression(expression);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function normalizeCronTimezone(timezone?: string | null): string | undefined {
  const value = timezone?.trim();
  if (!value) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return undefined;
  }
}

function dateParts(date: Date, timezone?: string) {
  if (!timezone) {
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      dayOfMonth: date.getDate(),
      month: date.getMonth() + 1,
      dayOfWeek: date.getDay(),
    };
  }
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, formatter);
  }
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number.parseInt(part.value, 10)]),
  ) as Record<string, number>;
  const year = values.year!;
  const month = values.month!;
  const dayOfMonth = values.day!;
  return {
    minute: values.minute!,
    hour: values.hour!,
    dayOfMonth,
    month,
    dayOfWeek: new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay(),
  };
}

export function cronMatchesDate(
  expression: string | ParsedCronExpression,
  date: Date,
  timezone?: string,
): boolean {
  const cron = typeof expression === "string" ? parseCronExpression(expression) : expression;
  const parts = dateParts(date, timezone);
  return cronMatchesParts(cron, parts);
}

function cronMatchesParts(
  cron: ParsedCronExpression,
  parts: ReturnType<typeof dateParts>,
): boolean {
  if (!cron.minute.values.has(parts.minute)) return false;
  if (!cron.hour.values.has(parts.hour)) return false;
  if (!cron.month.values.has(parts.month)) return false;
  const dom = cron.dayOfMonth.values.has(parts.dayOfMonth);
  const dow = cron.dayOfWeek.values.has(parts.dayOfWeek);
  const dayMatches = cron.dayOfMonth.wildcard ? dow : cron.dayOfWeek.wildcard ? dom : dom || dow;
  return dayMatches;
}

/** Return the next matching real instant, strictly after `after`. */
export function computeNextCronRun(
  expression: string,
  after: Date = new Date(),
  timezone?: string,
): Date {
  const parsed = parseCronExpression(expression);
  if (timezone && !normalizeCronTimezone(timezone))
    throw new Error(`invalid timezone: ${timezone}`);
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const deadline = candidate.getTime() + 366 * 24 * 60 * 60_000 * 5;
  while (candidate.getTime() <= deadline) {
    const parts = dateParts(candidate, timezone);
    if (cronMatchesParts(parsed, parts)) return candidate;

    const dom = parsed.dayOfMonth.values.has(parts.dayOfMonth);
    const dow = parsed.dayOfWeek.values.has(parts.dayOfWeek);
    const dayMatches = parsed.dayOfMonth.wildcard
      ? dow
      : parsed.dayOfWeek.wildcard
        ? dom
        : dom || dow;
    if (
      !parsed.month.values.has(parts.month) ||
      !dayMatches ||
      !parsed.hour.values.has(parts.hour)
    ) {
      // Skip to the next local-hour boundary. This keeps DST and non-whole-hour
      // timezone offsets correct while reducing sparse schedules from ~2.6m
      // minute checks to at most a few thousand hourly checks.
      const minutes = parts.minute === 0 ? 60 : 60 - parts.minute;
      candidate.setTime(candidate.getTime() + minutes * 60_000);
      continue;
    }
    candidate.setTime(candidate.getTime() + 60_000);
  }
  throw new Error("cron expression has no match within 5 years");
}
