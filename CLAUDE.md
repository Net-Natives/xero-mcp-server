# CLAUDE.md

## Packaging for enterprise deployment

The server ships as a Claude Desktop MCPB bundle (`.mcpb`). The manifest is at `manifest.json`, the packaging script is `scripts/pack-mcpb.mjs`, the npm task is `npm run pack:mcpb`.

### Build the bundle

```bash
npm run pack:mcpb
```

This:
1. Runs `npm run build` (TypeScript → `dist/`).
2. Validates `manifest.json` against the MCPB schema.
3. Stages `dist/`, `package.json`, `package-lock.json`, `manifest.json` into `build/mcpb-staging/`.
4. Runs `npm ci --omit=dev --ignore-scripts` in staging to populate production-only `node_modules`. `--ignore-scripts` is required because the `prepare` lifecycle hook would otherwise re-run `tsc` (a devDependency).
5. Packs the staging dir into `build/xero-mcp-server-<version>.mcpb` via `@anthropic-ai/mcpb pack`.

Output goes to `build/`, which is gitignored (`build/`, `*.mcpb`).

### Bumping versions

Update `version` in **both** `package.json` and `manifest.json` — they must match. The output filename uses `package.json` `version`.

### Manifest template + local credential override

The committed `manifest.json` is a **template**: `XERO_CLIENT_ID` and `XERO_CLIENT_SECRET` reference `${user_config.*}`, and the `user_config` block declares Claude Desktop install-time prompts for them. Out of the box, the bundle prompts each operator for their own credentials.

For enterprise builds where a single shared Xero OAuth app is embedded across the fleet, drop a `manifest.local.json` next to the committed manifest:

```json
{
  "env": {
    "XERO_CLIENT_ID": "...",
    "XERO_CLIENT_SECRET": "..."
  }
}
```

The pack script (`scripts/pack-mcpb.mjs`) detects this file and, at staging time:
1. Merges `env` into `manifest.server.mcp_config.env` (literal values overwrite the `${user_config.*}` references).
2. Strips matching keys from `user_config` (so operators aren't prompted for values that will be ignored).
3. If `user_config` ends up empty, removes it entirely.

The committed manifest is unchanged — the override only affects the staged copy that gets packed into the `.mcpb`.

Important:
- `manifest.local.json` is **gitignored** and must never be committed. A committed `manifest.local.json.example` shows the shape with placeholder values.
- The output `.mcpb` is sensitive when an override is active — anyone with the file can extract the embedded secret. Treat distribution channels as confidential.
- Rotating an embedded secret means updating `manifest.local.json`, bumping `version` in `package.json` and `manifest.json`, re-packing, and re-distributing.
- The bundle is only for PKCE deployments. Bearer-token and Custom-Connections modes need direct `claude_desktop_config.json` edits.

To expose runtime knobs (`XERO_TOKEN_STORE`, `XERO_PKCE_DEBUG`, etc.) add entries to the committed `user_config` block and reference them via `${user_config.<key>}` in `mcp_config.env`.

### Distribution

The output `.mcpb` is a single zipped archive. Drop-installable methods:

- **Manual**: end users double-click the file → Claude Desktop opens its install dialog → user fills in `client_id` / `client_secret`.
- **MDM / fleet**: drop the `.mcpb` into the system-wide extensions directory (per your MDM tooling). Claude Desktop scans both per-user and system-wide locations.
- **Signing** (optional): `npx @anthropic-ai/mcpb sign <file>` — requires a code-signing key. Unsigned bundles work but install with a "this bundle is not signed" warning.

### Required Xero app config

The packaged server runs PKCE auth on `https://localhost:8765/callback`. Each operator who installs the bundle needs:
- A Xero OAuth 2.0 app (standard, not a Custom Connection) at https://developer.xero.com/app/manage.
- The redirect URI `https://localhost:8765/callback` registered. To allow port fallback (server cycles 8765 → 8770), register all six.
- The first auth flow generates a self-signed cert via `openssl` (cached at `~/.xero-mcp-server/certs/`). Browser shows "Your connection is not private" — operator clicks through. Installing `mkcert` and running `mkcert -install` removes the warning.

### Key runtime files (per-operator, on macOS)

- Tokens: macOS Keychain entry, service `xero-mcp-server`, account = the operator's Xero `client_id`. Verify with `security find-generic-password -s xero-mcp-server`.
- TLS cert: `~/.xero-mcp-server/certs/{cert,key}.pem` (regenerated within 7 days of expiry).
- PKCE log: `~/.xero-mcp-server/pkce.log` — first thing to check when troubleshooting an operator's auth failure.

### Auth-mode handling for the `re-authenticate` tool

`re-authenticate` only works when the server runs in PKCE mode (the bundle's only mode). The handler at `src/handlers/re-authenticate-xero.handler.ts` returns a clear error otherwise.
