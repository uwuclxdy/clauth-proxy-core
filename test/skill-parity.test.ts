import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHAPES } from "../src/index.ts";
import { adminHeaders, cleanupTestDirs, makeTestServer, waitFor } from "./helpers.ts";

const SKILL_PATH = join(import.meta.dir, "..", "skills", "clauth-proxy-contract", "SKILL.md");

function cells(line: string): string[] {
  return line
    .split("|")
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

function sections(md: string): Map<string, string[]> {
  const lines = md.split("\n");
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      out.set(current, []);
    } else if (current !== null) {
      out.get(current)!.push(line);
    }
  }
  return out;
}

function routeSet(lines: string[]): Set<string> {
  const rows = lines.filter((l) => l.startsWith("|")).map(cells).slice(2);
  const set = new Set<string>();
  for (const row of rows) {
    const path = row[1]!.replace(/\{(\w+)\}/g, ":$1");
    set.add(`${row[0]!.toUpperCase()} ${path}`);
  }
  return set;
}

function fieldTables(lines: string[]): Map<string, Set<string>> {
  const tables = new Map<string, string[][]>();
  let current: string | null = null;
  for (const line of lines) {
    if (line.startsWith("### ")) {
      current = line.slice(4).trim();
      tables.set(current, []);
    } else if (current !== null && line.startsWith("|")) {
      tables.get(current)!.push(cells(line));
    }
  }
  const out = new Map<string, Set<string>>();
  for (const [name, rows] of tables) {
    const set = new Set<string>();
    for (const row of rows.slice(2)) {
      if (row[0] !== undefined) set.add(row[0]);
    }
    out.set(name, set);
  }
  return out;
}

/** Required fields per table: the `req` column reads exactly `yes`. */
function requiredFields(lines: string[]): Map<string, Set<string>> {
  const tables = new Map<string, string[][]>();
  let current: string | null = null;
  for (const line of lines) {
    if (line.startsWith("### ")) {
      current = line.slice(4).trim();
      tables.set(current, []);
    } else if (current !== null && line.startsWith("|")) {
      tables.get(current)!.push(cells(line));
    }
  }
  const out = new Map<string, Set<string>>();
  for (const [name, rows] of tables) {
    const set = new Set<string>();
    for (const row of rows.slice(2)) {
      if (row[0] !== undefined && row[2] === "yes") set.add(row[0]);
    }
    out.set(name, set);
  }
  return out;
}

function topLevelFields(obj: unknown): Set<string> {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return new Set();
  return new Set(Object.keys(obj as Record<string, unknown>));
}

describe("contract skill parity", () => {
  test("the skill's routes match the running router, both directions", () => {
    const md = readFileSync(SKILL_PATH, "utf8");
    const skillRoutes = routeSet(sections(md).get("Routes")!);

    const s = makeTestServer({ capabilities: ["events", "count_tokens"] });
    const routerRoutes = new Set<string>();
    for (const route of s.app.routes as Array<{ method: string; path: string } | [string, string, unknown]>) {
      const method = Array.isArray(route) ? route[0] : route.method;
      const path = Array.isArray(route) ? route[1] : route.path;
      if (method === "ALL") continue; // middleware mounts, not endpoints
      routerRoutes.add(`${method.toUpperCase()} ${path}`);
    }
    s.server.close();
    cleanupTestDirs();

    expect([...routerRoutes].filter((r) => !skillRoutes.has(r))).toEqual([]);
    expect([...skillRoutes].filter((r) => !routerRoutes.has(r))).toEqual([]);
  });

  test("the skill's field tables match the response schemas, both directions", () => {
    const md = readFileSync(SKILL_PATH, "utf8");
    const skillFields = fieldTables(sections(md).get("Field tables")!);

    expect(Object.keys(SHAPES).filter((k) => !skillFields.has(k))).toEqual([]);
    expect([...skillFields.keys()].filter((k) => !(k in SHAPES))).toEqual([]);

    for (const [name, schema] of Object.entries(SHAPES)) {
      const schemaFields = new Set(Object.keys(schema.shape));
      const skill = skillFields.get(name)!;
      expect([...schemaFields].filter((f) => !skill.has(f))).toEqual([]);
      expect([...skill].filter((f) => !schemaFields.has(f))).toEqual([]);
    }
  });

  test("the skill names the wire-parity workflow", () => {
    const md = readFileSync(SKILL_PATH, "utf8");
    expect(md).toContain("## Wire parity");
    expect(md).toContain("reference client");
    expect(md).toContain("fixture upstream");
    expect(md).toContain("open an issue");
  });

  test("the served field names match the skill's tables, both directions", async () => {
    const md = readFileSync(SKILL_PATH, "utf8");
    const fields = fieldTables(sections(md).get("Field tables")!);
    const required = requiredFields(sections(md).get("Field tables")!);

    const s = makeTestServer({ capabilities: ["events", "count_tokens"] });

    // login once for an account + key, capturing the key on the first done read
    const loginRes = await s.app.request("/clauth/v1/accounts/login", {
      method: "POST",
      headers: adminHeaders(),
      body: "{}",
    });
    const loginBody = (await loginRes.json()) as { flow: string };
    const start = loginBody;
    let done: { account: { id: string }; inference_key: string } | undefined;
    await waitFor(async () => {
      const r = await s.app.request(`/clauth/v1/accounts/login/${start.flow}`, { headers: adminHeaders() });
      const j = (await r.json()) as { state: string; account?: { id: string }; inference_key?: string };
      if (j.state === "done") {
        done = j as { account: { id: string }; inference_key: string };
        return true;
      }
      return false;
    });
    const id = done!.account.id;
    await s.server.usage.pollOne(s.store.get(id)!);

    const served: Record<string, Set<string>> = {};
    served["health"] = topLevelFields(await (await s.app.request("/health")).json());
    served["info"] = topLevelFields(await (await s.app.request("/clauth/v1/info", { headers: adminHeaders() })).json());
    served["accounts"] = topLevelFields(await (await s.app.request("/clauth/v1/accounts", { headers: adminHeaders() })).json());
    served["login-start"] = topLevelFields(loginBody);
    served["login-status"] = topLevelFields(done);
    served["key"] = topLevelFields(
      await (await s.app.request(`/clauth/v1/accounts/${id}/key`, { method: "POST", headers: adminHeaders() })).json(),
    );
    served["action-accepted"] = topLevelFields(
      await (
        await s.app.request(`/clauth/v1/accounts/${id}/actions/claim-now`, {
          method: "POST",
          headers: adminHeaders(),
          body: JSON.stringify({ target: "x" }),
        })
      ).json(),
    );
    served["usage"] = topLevelFields(await (await s.app.request("/clauth/v1/usage", { headers: adminHeaders() })).json());
    served["config-get"] = topLevelFields(await (await s.app.request("/clauth/v1/config", { headers: adminHeaders() })).json());
    served["config-patch"] = topLevelFields(
      await (
        await s.app.request("/clauth/v1/config", {
          method: "PATCH",
          headers: adminHeaders(),
          body: JSON.stringify({ values: {} }),
        })
      ).json(),
    );
    served["control-error"] = topLevelFields(
      await (await s.app.request("/clauth/v1/accounts", { headers: { authorization: "Bearer " + "f".repeat(64) } })).json(),
    );
    served["inference-error"] = topLevelFields(
      await (await s.app.request("/v1/messages", { method: "POST", body: JSON.stringify({}) })).json(),
    );

    for (const [name, servedSet] of Object.entries(served)) {
      const skillSet = fields.get(name);
      expect(skillSet).toBeDefined();
      // every served field is named in the skill
      expect([...servedSet].filter((f) => !skillSet!.has(f))).toEqual([]);
      // every required field is actually served
      expect([...required.get(name)!].filter((f) => !servedSet.has(f))).toEqual([]);
    }

    s.server.close();
    cleanupTestDirs();
  });

  test("the skill names the SSE events the core publishes", () => {
    const md = readFileSync(SKILL_PATH, "utf8");
    for (const event of ["account", "usage", "login", "account_deleted"]) {
      expect(md).toContain(`\`${event}\``);
    }
    expect(md).toContain("## SSE events");
  });
});
