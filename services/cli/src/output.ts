/** Machine-stable JSON and small human tables. */
export type Write = (text: string) => void;

function scalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function renderTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(empty)\n";
  const keys = Object.keys(rows[0] ?? {}).filter((key) => {
    const value = rows[0]?.[key];
    return value === null || typeof value !== "object";
  });
  const widths = keys.map((key) =>
    Math.max(key.length, ...rows.map((row) => scalar(row[key]).length)),
  );
  const line = (values: string[]): string =>
    values
      .map((value, index) => value.padEnd(widths[index] ?? value.length))
      .join("  ")
      .trimEnd();
  const output = [line(keys), line(keys.map((_, index) => "-".repeat(widths[index] ?? 0)))];
  for (const row of rows) output.push(line(keys.map((key) => scalar(row[key]))));
  return `${output.join("\n")}\n`;
}

export function renderHuman(value: unknown): string {
  if (Array.isArray(value)) return renderTable(value as Record<string, unknown>[]);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) {
      const table = renderTable(record.data as Record<string, unknown>[]);
      return `${table}${record.next_cursor ? `next_cursor: ${String(record.next_cursor)}\n` : ""}`;
    }
    return `${Object.entries(record)
      .map(([key, entry]) => `${key}: ${scalar(entry)}`)
      .join("\n")}\n`;
  }
  return `${scalar(value)}\n`;
}
