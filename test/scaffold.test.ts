import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Pkg {
  name: string;
  license: string;
  engines: { bun: string };
  scripts: { check: string };
  main: string;
  exports: Record<string, string>;
}

function pkg(): Pkg {
  return JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as Pkg;
}

describe("scaffold", () => {
  test("the package is the shared proxy core with a dual license and a check script", () => {
    expect(pkg().name).toBe("clauth-proxy-core");
    expect(pkg().license).toBe("MIT OR Apache-2.0");
    expect(pkg().engines.bun).toBe(">=1.3.0");
    expect(pkg().scripts.check).toBe("tsc --noEmit && bun test");
  });

  test("the package resolves by name as a dependency", async () => {
    expect(pkg().exports["."]).toBe("./src/index.ts");
    const dir = mkdtempSync(join(tmpdir(), "clauth-proxy-core-pkg-"));
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync(join(import.meta.dir, ".."), join(dir, "node_modules", "clauth-proxy-core"));
    try {
      const proc = Bun.spawn(
        ["bun", "-e", "const m = await import('clauth-proxy-core'); console.log(typeof m.defineProxy)"],
        { cwd: dir, stdout: "pipe", stderr: "pipe" },
      );
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      expect(out.trim()).toBe("function");
      if (err.trim() !== "") expect(err.trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
