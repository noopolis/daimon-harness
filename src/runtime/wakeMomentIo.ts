import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Dir } from "node:fs";
import { performance } from "node:perf_hooks";

export class WakeMomentFault extends Error {
  constructor(readonly reason: string) { super(reason); }
}

/** Internal fault-injection seam, never configuration or a public runtime export. */
export type WakeMomentIoProbe = (operation: string, target?: string, entries?: number) => void | Promise<void>;

/** Every filesystem call checks cancellation before issuing I/O and after it settles. */
export class WakeMomentIo {
  readonly fs: typeof fs;
  verifyWrite?: (target?: string) => Promise<void>;
  private aborted = false;
  private expires = Infinity;

  constructor(private readonly probe?: WakeMomentIoProbe) {
    this.fs = new Proxy(fs, {
      get: (target, key) => {
        const method = Reflect.get(target, key);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => this.call(String(key), async () => {
          const result = await Reflect.apply(method, target, args);
          if (key === "open") return this.handle(result as FileHandle, String(args[0]));
          if (key === "opendir") return this.directory(result as Dir, String(args[0]));
          if (key === "readdir") await this.probe?.("directoryEntries", String(args[0]), (result as unknown[]).length);
          return result;
        }, typeof args[key === "symlink" || key === "link" ? 1 : 0] === "string" ? String(args[key === "symlink" || key === "link" ? 1 : 0]) : undefined);
      }
    });
  }

  check(): void {
    if (this.aborted || performance.now() >= this.expires) {
      this.aborted = true;
      throw new WakeMomentFault("capture_deadline_exceeded");
    }
  }

  async call<T>(operation: string, action: () => Promise<T>, target?: string): Promise<T> {
    this.check();
    await this.probe?.(operation, target);
    this.check();
    if (["open", "mkdir", "rename", "rm", "unlink", "rmdir", "link", "symlink", "write", "writeFile", "chmod"].includes(operation)) {
      await this.verifyWrite?.(target);
      this.check();
    }
    const result = await action();
    try { this.check(); }
    catch (error) {
      // An open already in flight can finish after abandonment; release its handle.
      if (result && typeof (result as { close?: unknown }).close === "function") {
        void (result as unknown as { close(): Promise<void> }).close().catch(() => undefined);
      }
      throw error;
    }
    return result;
  }

  async bounded<T>(milliseconds: number, action: () => Promise<T>): Promise<T> {
    this.expires = performance.now() + milliseconds;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.aborted = true;
        reject(new WakeMomentFault("capture_deadline_exceeded"));
      }, milliseconds);
    });
    try { return await Promise.race([action(), deadline]); }
    finally { clearTimeout(timer); this.aborted = true; }
  }

  private handle(handle: FileHandle, target: string): FileHandle {
    return new Proxy(handle, { get: (fd, key) => {
      const method = Reflect.get(fd, key, fd);
      if (typeof method !== "function") return method;
      if (key === "close") return method.bind(fd); // Closing never publishes data.
      return (...args: unknown[]) => this.call(String(key), async () => Reflect.apply(method, fd, args), target);
    } });
  }

  private directory(directory: Dir, target: string): Dir {
    const io = this;
    return new Proxy(directory, { get: (dir, key) => {
      if (key === Symbol.asyncIterator) return async function* () {
        try {
          for (;;) {
            const entry = await io.call("readdir", () => dir.read(), target);
            if (!entry) break;
            await io.probe?.("directoryEntries", target, 1);
            io.check();
            yield entry;
          }
        } finally { await dir.close(); }
      };
      const method = Reflect.get(dir, key, dir);
      return typeof method === "function" ? method.bind(dir) : method;
    } });
  }
}
