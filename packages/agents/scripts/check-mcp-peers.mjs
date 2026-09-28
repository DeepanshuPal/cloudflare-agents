/**
 * Check the published package boundary from an external consumer. Build agents
 * first; this test deliberately packs dist rather than importing source.
 *
 * Run: pnpm --filter agents run build && pnpm --filter agents run test:mcp-peers
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "agents-mcp-peer-"));
const versions = [
  { sdk: "1.30.0", client: "2.0.0", server: "2.0.0" },
  { sdk: "1.30.1", client: "2.1.0", server: "2.1.0" }
];

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit", timeout: 120_000 });
}

try {
  const tarball = execFileSync(
    "npm",
    ["pack", "--silent", "--pack-destination", scratch],
    {
      cwd: packageDir,
      encoding: "utf8"
    }
  ).trim();

  for (const { sdk, client, server } of versions) {
    const consumer = join(scratch, `consumer-${sdk}-${server}`);
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "agents-mcp-external-consumer",
        private: true,
        type: "module",
        dependencies: {
          agents: `file:${join(scratch, tarball)}`,
          "@modelcontextprotocol/sdk": sdk,
          "@modelcontextprotocol/client": client,
          "@modelcontextprotocol/server": server
        },
        devDependencies: { typescript: "6.0.3", "@types/node": "26.0.1" }
      })
    );
    writeFileSync(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: ["node"]
        },
        include: ["consumer.ts"]
      })
    );
    writeFileSync(
      join(consumer, "consumer.ts"),
      `
import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as ModernMcpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, createLegacyMcpHandler } from "agents/mcp";
import { createMcpHandler as createStatelessMcpHandler } from "agents/mcp/server";
const legacy = new LegacyMcpServer({ name: "consumer", version: "1.0.0" });
createMcpHandler(legacy);
createLegacyMcpHandler(legacy);
createMcpHandler(() => new ModernMcpServer({ name: "consumer", version: "1.0.0" }));
createStatelessMcpHandler(() => new ModernMcpServer({ name: "consumer", version: "1.0.0" }));
`
    );

    // npm's default resolution fails on a conflicting peer. Also assert one
    // resolved SDK version, since a passing typecheck of only one path is not enough.
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--omit=optional",
        "--strict-peer-deps",
        "--no-audit",
        "--no-fund"
      ],
      consumer
    );
    const tree = JSON.parse(
      execFileSync(
        "npm",
        [
          "ls",
          "@modelcontextprotocol/sdk",
          "@modelcontextprotocol/client",
          "@modelcontextprotocol/server",
          "--all",
          "--json"
        ],
        { cwd: consumer, encoding: "utf8" }
      )
    );
    for (const [name, expected] of Object.entries({
      "@modelcontextprotocol/sdk": sdk,
      "@modelcontextprotocol/client": client,
      "@modelcontextprotocol/server": server
    })) {
      if (
        tree.dependencies[name]?.version !== expected ||
        tree.dependencies.agents?.dependencies?.[name]?.version !== expected
      ) {
        throw new Error(
          `${name} did not resolve to one ${expected} peer universe`
        );
      }
    }
    run(join(consumer, "node_modules/.bin/tsc"), ["--noEmit"], consumer);
    console.log(
      `MCP external consumer passed: sdk ${sdk}, client ${client}, server ${server}`
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
