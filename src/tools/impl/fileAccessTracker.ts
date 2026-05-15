import { statSync } from "node:fs";

interface ReadRecord {
  mtimeMs: number;
  size: number;
  consecutiveReads: number;
  lastKey: string;
}

const readRecords = new Map<string, ReadRecord>();

function statFile(
  filePath: string,
): { mtimeMs: number; size: number } | undefined {
  try {
    const stats = statSync(filePath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return undefined;
  }
}

export function noteFileRead(
  filePath: string,
  options: { offset?: number; limit?: number } = {},
): string | undefined {
  const stat = statFile(filePath);
  if (!stat) return undefined;
  const key = `${filePath}:${options.offset ?? ""}:${options.limit ?? ""}:${stat.mtimeMs}:${stat.size}`;
  const previous = readRecords.get(filePath);
  const consecutiveReads =
    previous?.lastKey === key ? previous.consecutiveReads + 1 : 1;
  readRecords.set(filePath, { ...stat, consecutiveReads, lastKey: key });
  if (consecutiveReads >= 4) {
    return `\n\n[Read-loop warning: this unchanged file/range has been read ${consecutiveReads} consecutive times. Prefer using the content already in context or narrow the next read to a different range.]`;
  }
  return undefined;
}

export function fileStalenessWarning(filePath: string): string | undefined {
  const previous = readRecords.get(filePath);
  if (!previous) return undefined;
  const current = statFile(filePath);
  if (!current) return undefined;
  if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
    return `Warning: ${filePath} changed on disk after it was last read by this agent. Re-read the file if this edit relied on old context.`;
  }
  return undefined;
}

export function noteFileWrite(filePath: string): void {
  const current = statFile(filePath);
  if (!current) return;
  readRecords.set(filePath, {
    ...current,
    consecutiveReads: 0,
    lastKey: `${filePath}:write:${current.mtimeMs}:${current.size}`,
  });
}
