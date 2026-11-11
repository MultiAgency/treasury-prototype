import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function syncDirectory(directory: string) {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Persist each newly created directory entry, including nested APP_STATE or token directories. */
export function mkdirDurable(directory: string) {
  const firstCreated = mkdirSync(directory, { recursive: true, mode: 0o700 });
  let child = resolve(directory);
  for (;;) {
    syncDirectory(dirname(child));
    if (!firstCreated || child === resolve(firstCreated)) break;
    child = dirname(child);
  }
}

/**
 * Writes `text` so that a crash leaves either the old file or the whole new one, readable only by this user. Each
 * write's temporary file has its own name, so one left behind by a crash never blocks a later write (a restarted
 * container often has the same PID); the directory is synced after the rename, so the new name survives a crash too.
 */
export function writeDurable(file: string, text: string) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
  syncDirectory(dirname(file));
}
