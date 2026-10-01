import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Sensitive local-only artifacts. Trace failures must never reject a customer request. */
export async function createDemoTrace(enabled: boolean, root: string, label: string): Promise<string | undefined> {
  if (!enabled) return;
  const safe = label.replace(/[^a-z0-9-]/gi, "-").slice(0, 100);
  const directory = resolve(
    root,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${safe}-${randomUUID().slice(0, 8)}`,
  );
  try {
    await mkdir(directory, { recursive: true });
    return directory;
  } catch {
    return;
  }
}

export async function writeTrace(trace: string | undefined, filename: string, content: Buffer | object): Promise<void> {
  if (!trace) return;
  try {
    await writeFile(
      join(trace, filename),
      Buffer.isBuffer(content) ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  } catch {
    /* Diagnostic output is best effort. */
  }
}
