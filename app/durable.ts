import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

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
  const directory = openSync(dirname(file), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
