#!/usr/bin/env node
import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const buildDir = join(root, "build");
const staging = join(buildDir, "mcpb-staging");
const localOverridePath = join(root, "manifest.local.json");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const output = join(buildDir, `xero-mcp-server-${pkg.version}.mcpb`);

const run = (cmd, cwd = root) => {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
};

console.log("→ Building TypeScript");
run("npm run build");

console.log("→ Validating committed manifest template");
run("npx --yes @anthropic-ai/mcpb@latest validate manifest.json");

console.log("→ Resetting staging directory");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

console.log("→ Copying bundle contents into staging");
for (const entry of ["dist", "package.json", "package-lock.json", "manifest.json"]) {
  const src = join(root, entry);
  if (!existsSync(src)) {
    throw new Error(`Required entry not found: ${entry}`);
  }
  cpSync(src, join(staging, entry), { recursive: true });
}

if (existsSync(localOverridePath)) {
  console.log(`→ Applying local override from ${localOverridePath}`);
  applyLocalOverride(join(staging, "manifest.json"), localOverridePath);
} else {
  console.log(
    "→ No manifest.local.json found; bundle will prompt operators for client_id/client_secret",
  );
}

console.log("→ Validating staged manifest");
run(`npx --yes @anthropic-ai/mcpb@latest validate "${join(staging, "manifest.json")}"`);

console.log("→ Installing production dependencies in staging");
// --ignore-scripts skips the prepare hook (which would otherwise re-run tsc
// and need the devDependencies we are deliberately omitting).
run("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", staging);

console.log("→ Removing staging package-lock.json (not needed in bundle)");
rmSync(join(staging, "package-lock.json"), { force: true });

console.log("→ Packing .mcpb");
run(`npx --yes @anthropic-ai/mcpb@latest pack "${staging}" "${output}"`);

console.log("");
console.log(`Bundle written to: ${output}`);

/**
 * Merge `env` from manifest.local.json into the staged manifest's
 * mcp_config.env. Any user_config keys whose names match the override env
 * (case-insensitive) are removed from the staged manifest, since they would
 * otherwise prompt operators for values that are about to be ignored.
 */
function applyLocalOverride(stagedManifestPath, overridePath) {
  const manifest = JSON.parse(readFileSync(stagedManifestPath, "utf8"));
  const override = JSON.parse(readFileSync(overridePath, "utf8"));

  if (!override.env || typeof override.env !== "object") {
    throw new Error(
      `manifest.local.json must contain an "env" object; got: ${JSON.stringify(override)}`,
    );
  }

  manifest.server ??= {};
  manifest.server.mcp_config ??= {};
  manifest.server.mcp_config.env ??= {};
  Object.assign(manifest.server.mcp_config.env, override.env);

  if (manifest.user_config) {
    const overriddenEnvKeys = new Set(
      Object.keys(override.env).map((k) => k.toLowerCase()),
    );
    const remaining = {};
    for (const [key, value] of Object.entries(manifest.user_config)) {
      // Drop a user_config entry if any overridden env name ends with its key
      // (matches the convention XERO_CLIENT_ID ↔ user_config.client_id).
      const dropped = [...overriddenEnvKeys].some((envName) =>
        envName.endsWith(`_${key.toLowerCase()}`) || envName === key.toLowerCase(),
      );
      if (!dropped) {
        remaining[key] = value;
      }
    }
    if (Object.keys(remaining).length === 0) {
      delete manifest.user_config;
    } else {
      manifest.user_config = remaining;
    }
  }

  writeFileSync(
    stagedManifestPath,
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
}
