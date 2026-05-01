import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer as createHttpsServer, ServerOptions } from "node:https";
import { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createNetServer, AddressInfo } from "node:net";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

import * as oidc from "openid-client";

import { ensureError } from "../helpers/ensure-error.js";
import { MCPXeroClient } from "./mcp-xero-client.js";
import { ensureLocalhostTLS, TLSMaterials } from "./pkce-cert.js";
import {
  PersistedTokens,
  selectTokenStore,
  TokenStore,
} from "./pkce-token-store.js";

const ISSUER_URL = new URL("https://identity.xero.com");
const CALLBACK_PATH = "/callback";
const DEFAULT_PORT_START = 8765;
const PORT_RANGE = 6;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const REFRESH_LEEWAY_S = 60;

const DEFAULT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.invoices",
  "accounting.payments",
  "accounting.banktransactions",
  "accounting.manualjournals",
  "accounting.reports.aged.read",
  "accounting.reports.balancesheet.read",
  "accounting.reports.profitandloss.read",
  "accounting.reports.trialbalance.read",
  "accounting.contacts",
  "accounting.settings",
  "payroll.settings",
  "payroll.employees",
  "payroll.timesheets",
].join(" ");

function defaultLogPath(): string {
  return process.env.XERO_PKCE_LOG_FILE
    ?? join(homedir(), ".xero-mcp-server", "pkce.log");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const DEBUG_ENABLED = /^(1|true|yes|on)$/i.test(
  process.env.XERO_PKCE_DEBUG ?? "",
);

let logFileInitialized = false;
function ensureLogDir(): void {
  if (logFileInitialized) return;
  try {
    mkdirSync(dirname(defaultLogPath()), { recursive: true });
    logFileInitialized = true;
  } catch {
    /* best-effort */
  }
}

function logLine(
  level: "debug" | "info" | "warn" | "error",
  message: string,
): void {
  const stamp = new Date().toISOString();
  const line = `${stamp} [xero-mcp pkce] [${level}] ${message}\n`;
  process.stderr.write(line);
  ensureLogDir();
  try {
    appendFileSync(defaultLogPath(), line);
  } catch {
    /* best-effort */
  }
}

function logDebug(message: string): void {
  if (DEBUG_ENABLED) logLine("debug", message);
}

function logInfo(message: string): void {
  logLine("info", message);
}

function logWarn(message: string): void {
  logLine("warn", message);
}

function logError(message: string, err?: unknown): void {
  if (err === undefined) {
    logLine("error", message);
    return;
  }
  const e = ensureError(err);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr = err as any;
  const parts: string[] = [`${message}: ${e.message}`];
  if (anyErr?.code) parts.push(`code=${anyErr.code}`);
  if (anyErr?.cause) {
    const cause = anyErr.cause as Error & { code?: string };
    parts.push(`cause=${cause.message ?? String(cause)}`);
    if (cause.code) parts.push(`cause.code=${cause.code}`);
  }
  if (anyErr?.response?.body)
    parts.push(`body=${JSON.stringify(anyErr.response.body)}`);
  if (e.stack) parts.push(`stack=${e.stack.split("\n").slice(0, 5).join(" | ")}`);
  logLine("error", parts.join(" "));
}

const tokenStoreLogger = {
  info: logInfo,
  warn: logWarn,
  debug: logDebug,
};

function sanitizeBody(body: string): string {
  return body
    .replace(/(client_secret=)[^&]+/gi, "$1<redacted>")
    .replace(/(code=)[^&]+/gi, "$1<redacted>")
    .replace(/(refresh_token=)[^&]+/gi, "$1<redacted>")
    .replace(/(code_verifier=)[^&]+/gi, "$1<redacted>")
    .replace(/(access_token=)[^&]+/gi, "$1<redacted>");
}

const loggingFetch: oidc.CustomFetch = async (url, options) => {
  let bodyPreview = "";
  if (options.body !== undefined && options.body !== null) {
    if (typeof options.body === "string") {
      bodyPreview = options.body;
    } else if (options.body instanceof URLSearchParams) {
      bodyPreview = options.body.toString();
    } else {
      bodyPreview = `<${(options.body as { constructor: { name: string } }).constructor.name}>`;
    }
    bodyPreview = sanitizeBody(bodyPreview);
  }
  logDebug(
    `HTTP → ${options.method} ${url}${bodyPreview ? ` body=${bodyPreview}` : ""}`,
  );

  const response = await globalThis.fetch(url, options as RequestInit);
  const cloned = response.clone();
  const contentType = cloned.headers.get("content-type") ?? "(none)";
  let bodyText: string;
  try {
    bodyText = await cloned.text();
  } catch {
    bodyText = "<unreadable>";
  }
  const truncated =
    bodyText.length > 600 ? bodyText.slice(0, 600) + "...[truncated]" : bodyText;
  if (response.status >= 400) {
    logError(
      `HTTP ${response.status} ${url} content-type=${contentType} body=${truncated}`,
    );
  } else {
    logDebug(
      `HTTP ← ${response.status} ${url} content-type=${contentType} body=${truncated}`,
    );
  }
  return response;
};

function openBrowser(url: string): void {
  const cmd =
    platform() === "darwin"
      ? "open"
      : platform() === "win32"
        ? "cmd"
        : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", (err) => {
    logError(
      `Could not launch browser automatically. Open this URL manually:\n${url}`,
      err,
    );
  });
  child.unref();
}

async function findOpenPort(start: number, range: number): Promise<number> {
  for (let port = start; port < start + range; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createNetServer();
      probe.unref();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => {
        probe.close(() => resolve(true));
      });
    });
    logDebug(`Port probe ${port}: ${free ? "free" : "busy"}`);
    if (free) return port;
  }
  throw new Error(
    `No free port available in range ${start}-${start + range - 1} for OAuth callback.`,
  );
}

interface CallbackResult {
  url: URL;
}

function waitForCallback(
  port: number,
  expectedState: string,
  tls: TLSMaterials,
): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(
        new Error(
          `Timed out after ${AUTH_TIMEOUT_MS / 1000}s waiting for OAuth callback.`,
        ),
      );
    }, AUTH_TIMEOUT_MS);

    const tlsOptions: ServerOptions = {
      cert: tls.cert,
      key: tls.key,
    };

    const server = createHttpsServer(
      tlsOptions,
      (req: IncomingMessage, res: ServerResponse) => {
        logDebug(`Incoming callback request: method=${req.method} url=${req.url}`);
        if (!req.url) {
          res.statusCode = 400;
          res.end("Missing URL");
          return;
        }
        const url = new URL(req.url, `https://127.0.0.1:${port}`);
        if (url.pathname !== CALLBACK_PATH) {
          logDebug(`Ignoring request to unexpected path: ${url.pathname}`);
          res.statusCode = 404;
          res.end("Not found");
          return;
        }

        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        logDebug(
          `Callback params: code=${code ? "present" : "absent"} ` +
            `state=${state ? (state === expectedState ? "match" : "MISMATCH") : "absent"} ` +
            `error=${error ?? "none"}`,
        );

        if (error) {
          const description = url.searchParams.get("error_description") ?? "";
          logError(`Authorization server returned error: ${error} ${description}`);
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            `<html><body><h1>Authorization failed</h1><p>${error}: ${description}</p></body></html>`,
          );
          clearTimeout(timer);
          server.close();
          reject(new Error(`Authorization error: ${error} ${description}`));
          return;
        }

        if (!code || !state || state !== expectedState) {
          logError("Missing or invalid state/code on callback");
          res.statusCode = 400;
          res.end("Missing or invalid state/code");
          clearTimeout(timer);
          server.close();
          reject(new Error("Missing or invalid state/code on callback"));
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          "<html><body><h1>Xero authorization complete</h1>" +
            "<p>You can close this tab and return to your terminal.</p></body></html>",
        );
        clearTimeout(timer);
        server.close();
        resolve({ url });
      },
    );

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      logDebug(`Local listener bound to 127.0.0.1:${addr.port} (TLS)`);
    });
  });
}

export class PkceXeroClient extends MCPXeroClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly scopes: string;
  private readonly tokenStoreMode?: string;
  private readonly tokenFilePath?: string;
  private readonly redirectUriOverride?: string;
  private readonly portStart: number;

  private oidcConfig?: oidc.Configuration;
  private tokens?: PersistedTokens;
  private tokenStore?: TokenStore;
  private inFlight?: Promise<void>;

  constructor(config: {
    clientId: string;
    clientSecret: string;
    scopes?: string;
    tokenFilePath?: string;
    tokenStoreMode?: string;
    redirectUri?: string;
    portStart?: number;
  }) {
    super();
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.scopes = config.scopes ?? DEFAULT_SCOPES;
    this.tokenStoreMode = config.tokenStoreMode;
    this.tokenFilePath = config.tokenFilePath;
    this.redirectUriOverride = config.redirectUri;
    this.portStart = config.portStart ?? DEFAULT_PORT_START;
    logDebug(
      `PkceXeroClient constructed. ` +
        `clientId=${this.clientId.slice(0, 6)}... ` +
        `tokenStoreMode=${this.tokenStoreMode ?? "auto"} ` +
        `tokenFilePath=${this.tokenFilePath ?? "(default)"} ` +
        `portStart=${this.portStart} ` +
        `portRange=${this.portStart}-${this.portStart + PORT_RANGE - 1} ` +
        `redirectUriOverride=${this.redirectUriOverride ?? "none"} ` +
        `scopes='${this.scopes}'`,
    );
  }

  public async authenticate(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.doAuthenticate().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  /**
   * Wipe persisted and in-memory auth state, then run a fresh interactive
   * PKCE login. Resolves once the new token set has been issued and the
   * tenant list refreshed.
   */
  public async forceReauthenticate(): Promise<void> {
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* prior auth attempt errored — proceed with re-auth anyway */
      }
    }

    const store = await this.ensureTokenStore();

    this.tokens = undefined;
    this.clearActiveTenant();

    try {
      await store.delete();
      logInfo(`Cleared persisted tokens from ${store.describe()}`);
    } catch (err) {
      logWarn(
        `Failed to clear persisted tokens (continuing with re-auth): ${ensureError(err).message}`,
      );
    }

    await this.authenticate();
  }

  private async ensureTokenStore(): Promise<TokenStore> {
    if (!this.tokenStore) {
      this.tokenStore = await selectTokenStore({
        storeMode: this.tokenStoreMode,
        filePath: this.tokenFilePath,
        keychainAccount: this.clientId,
        log: tokenStoreLogger,
      });
      logInfo(`Token store: ${this.tokenStore.describe()}`);
    }
    return this.tokenStore;
  }

  private async doAuthenticate(): Promise<void> {
    logDebug("authenticate() called");
    try {
      await this.ensureConfig();
    } catch (err) {
      logError("OIDC discovery failed", err);
      throw err;
    }

    const store = await this.ensureTokenStore();

    if (!this.tokens) {
      this.tokens = await store.load();
    }

    if (this.tokens && !this.isAccessTokenValid(this.tokens)) {
      if (this.tokens.refresh_token) {
        try {
          logInfo("Refreshing expired access token");
          this.tokens = await this.refresh(this.tokens.refresh_token);
          await store.save(this.tokens);
          logInfo("Token refresh succeeded");
        } catch (err) {
          logError("Refresh failed; falling back to interactive login", err);
          this.tokens = undefined;
        }
      } else {
        logInfo("No refresh_token available; running interactive login");
        this.tokens = undefined;
      }
    }

    if (!this.tokens) {
      try {
        this.tokens = await this.runInteractiveLogin();
        await store.save(this.tokens);
        logInfo(`Tokens persisted to ${store.describe()}`);
      } catch (err) {
        logError("Interactive login failed", err);
        throw err;
      }
    }

    this.applyTokens(this.tokens);
    if (!this.tenantId) {
      try {
        await this.updateTenants();
        logInfo(
          `Authenticated. tenantId=${this.tenantId} ` +
            `tenantCount=${this.tenants?.length ?? 0}`,
        );
      } catch (err) {
        logError("updateTenants() failed", err);
        throw err;
      }
    }
  }

  private async ensureConfig(): Promise<oidc.Configuration> {
    if (!this.oidcConfig) {
      const authMethod = (
        process.env.XERO_TOKEN_AUTH_METHOD ?? "post"
      ).toLowerCase();
      const clientAuth =
        authMethod === "basic"
          ? oidc.ClientSecretBasic(this.clientSecret)
          : oidc.ClientSecretPost(this.clientSecret);
      this.oidcConfig = await oidc.discovery(
        ISSUER_URL,
        this.clientId,
        undefined,
        clientAuth,
      );
      this.oidcConfig[oidc.customFetch] = loggingFetch;
      const meta = this.oidcConfig.serverMetadata();
      logDebug(
        `OIDC discovery succeeded. ` +
          `issuer=${meta.issuer} ` +
          `authorization_endpoint=${meta.authorization_endpoint} ` +
          `token_endpoint=${meta.token_endpoint} ` +
          `auth_method=client_secret_${authMethod}`,
      );
    }
    return this.oidcConfig;
  }

  private isAccessTokenValid(tokens: PersistedTokens): boolean {
    if (!tokens.access_token) return false;
    if (typeof tokens.expires_at !== "number") return true;
    const remaining = tokens.expires_at - nowSeconds();
    const valid = remaining - REFRESH_LEEWAY_S > 0;
    logDebug(
      `Token validity: ${valid ? "valid" : "expired"} ` +
        `(${remaining}s remaining, leeway ${REFRESH_LEEWAY_S}s)`,
    );
    return valid;
  }

  private applyTokens(tokens: PersistedTokens): void {
    this.setTokenSet({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      token_type: tokens.token_type,
      scope: tokens.scope,
      expires_at: tokens.expires_at,
    });
  }

  private async refresh(refreshToken: string): Promise<PersistedTokens> {
    const config = await this.ensureConfig();
    const response = await oidc.refreshTokenGrant(config, refreshToken);
    return this.tokenResponseToPersisted(response, refreshToken);
  }

  private tokenResponseToPersisted(
    response: oidc.TokenEndpointResponse,
    fallbackRefreshToken?: string,
  ): PersistedTokens {
    const expiresAt =
      typeof response.expires_in === "number"
        ? nowSeconds() + response.expires_in
        : undefined;
    return {
      access_token: response.access_token,
      refresh_token: response.refresh_token ?? fallbackRefreshToken,
      id_token: response.id_token,
      token_type: response.token_type ?? "bearer",
      scope: response.scope,
      expires_at: expiresAt,
    };
  }

  private async runInteractiveLogin(): Promise<PersistedTokens> {
    const config = await this.ensureConfig();

    let port: number;
    let redirectUri: string;
    if (this.redirectUriOverride) {
      redirectUri = this.redirectUriOverride;
      const parsed = new URL(redirectUri);
      port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
    } else {
      port = await findOpenPort(this.portStart, PORT_RANGE);
      redirectUri = `https://localhost:${port}${CALLBACK_PATH}`;
    }

    const tls = await ensureLocalhostTLS({
      info: logInfo,
      warn: logWarn,
    });
    if (!tls.trusted) {
      logWarn(
        `Using ${tls.source} TLS cert at ${tls.certPath}. ` +
          "Browser will warn 'connection is not private' until you click through. " +
          "Install mkcert and run 'mkcert -install' to remove the warning.",
      );
    }

    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();

    const authUrl = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: this.scopes,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });

    logInfo(
      `Starting interactive PKCE login. redirect_uri=${redirectUri} ` +
        `(must be registered in your Xero app). ` +
        `If a browser does not open, visit: ${authUrl.toString()}`,
    );

    const callbackPromise = waitForCallback(port, state, tls);
    openBrowser(authUrl.toString());
    const { url: callbackUrl } = await callbackPromise;

    // Our local listener binds to 127.0.0.1, so the URL we receive carries that
    // host. We registered (and authorized with) `localhost`, so rewrite the
    // host back to match before openid-client derives redirect_uri from this
    // URL for the token endpoint exchange.
    const registeredRedirect = new URL(redirectUri);
    const normalizedCallback = new URL(callbackUrl.toString());
    normalizedCallback.protocol = registeredRedirect.protocol;
    normalizedCallback.hostname = registeredRedirect.hostname;
    normalizedCallback.port = registeredRedirect.port;

    let response: oidc.TokenEndpointResponse;
    try {
      response = await oidc.authorizationCodeGrant(
        config,
        normalizedCallback,
        { pkceCodeVerifier: codeVerifier, expectedState: state, idTokenExpected: false },
        { redirect_uri: redirectUri },
      );
    } catch (err) {
      logError("authorizationCodeGrant failed at token endpoint", err);
      throw err;
    }
    logInfo(
      `Token exchange succeeded ` +
        `(expires_in=${response.expires_in ?? "?"}, ` +
        `refresh_token=${response.refresh_token ? "present" : "absent"})`,
    );

    return this.tokenResponseToPersisted(response);
  }
}
