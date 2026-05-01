import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const DEFAULT_KEYCHAIN_SERVICE = "xero-mcp-server";
const SECURITY_BIN = "/usr/bin/security";

export interface PersistedTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  scope?: string;
  expires_at?: number;
}

export interface TokenStore {
  load(): Promise<PersistedTokens | undefined>;
  save(tokens: PersistedTokens): Promise<void>;
  delete(): Promise<void>;
  describe(): string;
}

interface TokenStoreLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

function defaultTokenFilePath(): string {
  return join(homedir(), ".xero-mcp-server", "tokens.json");
}

class FileTokenStore implements TokenStore {
  constructor(
    private readonly filePath: string,
    private readonly log: TokenStoreLogger,
  ) {}

  async load(): Promise<PersistedTokens | undefined> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedTokens;
      if (!parsed.access_token) {
        this.log.warn(
          `Token file ${this.filePath} present but missing access_token`,
        );
        return undefined;
      }
      this.log.debug(`Loaded tokens from file ${this.filePath}`);
      return parsed;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        this.log.debug(`No token file at ${this.filePath}`);
        return undefined;
      }
      this.log.warn(`Failed to read token file ${this.filePath}: ${e.message}`);
      return undefined;
    }
  }

  async save(tokens: PersistedTokens): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
    try {
      await fs.chmod(this.filePath, 0o600);
    } catch {
      /* best-effort */
    }
    this.log.debug(`Persisted tokens to file ${this.filePath}`);
  }

  async delete(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
      this.log.debug(`Deleted token file ${this.filePath}`);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return;
      throw err;
    }
  }

  describe(): string {
    return `file:${this.filePath}`;
  }
}

class KeychainTokenStore implements TokenStore {
  constructor(
    private readonly service: string,
    private readonly account: string,
    private readonly log: TokenStoreLogger,
  ) {}

  async load(): Promise<PersistedTokens | undefined> {
    try {
      const { stdout } = await execFileP(SECURITY_BIN, [
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        this.account,
        "-w",
      ]);
      const trimmed = stdout.trim();
      if (!trimmed) {
        return undefined;
      }
      const parsed = JSON.parse(trimmed) as PersistedTokens;
      if (!parsed.access_token) {
        this.log.warn("Keychain entry present but missing access_token");
        return undefined;
      }
      this.log.debug(
        `Loaded tokens from keychain (service=${this.service} account=${this.account})`,
      );
      return parsed;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      if (e.stderr?.includes("could not be found")) {
        this.log.debug(
          `No keychain entry for service=${this.service} account=${this.account}`,
        );
        return undefined;
      }
      this.log.warn(
        `Failed to read keychain entry: ${e.stderr?.trim() || e.message}`,
      );
      return undefined;
    }
  }

  async save(tokens: PersistedTokens): Promise<void> {
    const blob = JSON.stringify(tokens);
    // Note: the JSON blob is briefly visible in argv to other processes owned
    // by the same user (`ps`). On a single-user macOS workstation this is
    // acceptable — anyone who can `ps` you can already read your keychain.
    await execFileP(SECURITY_BIN, [
      "add-generic-password",
      "-U",
      "-s",
      this.service,
      "-a",
      this.account,
      "-w",
      blob,
    ]);
    this.log.debug(
      `Persisted tokens to keychain (service=${this.service} account=${this.account})`,
    );
  }

  async delete(): Promise<void> {
    try {
      await execFileP(SECURITY_BIN, [
        "delete-generic-password",
        "-s",
        this.service,
        "-a",
        this.account,
      ]);
      this.log.debug(
        `Deleted keychain entry (service=${this.service} account=${this.account})`,
      );
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      if (e.stderr?.includes("could not be found")) return;
      throw err;
    }
  }

  describe(): string {
    return `keychain:${this.service}:${this.account}`;
  }
}

export interface TokenStoreOptions {
  storeMode?: string;
  filePath?: string;
  keychainService?: string;
  keychainAccount: string;
  log: TokenStoreLogger;
}

/**
 * Select a TokenStore based on the requested mode.
 *
 * Modes:
 *   - "auto" (default): keychain on macOS, file elsewhere
 *   - "keychain": macOS Keychain (errors on non-darwin)
 *   - "file": JSON file at filePath (defaults to ~/.xero-mcp-server/tokens.json)
 *
 * If keychain is selected and a legacy token file exists, the file's tokens
 * are migrated into the keychain on first load. The file is left in place so
 * the migration is non-destructive; the user should delete it manually once
 * happy.
 */
export async function selectTokenStore(
  opts: TokenStoreOptions,
): Promise<TokenStore> {
  const requested = (opts.storeMode ?? "auto").toLowerCase();
  const filePath = opts.filePath ?? defaultTokenFilePath();
  const keychainService = opts.keychainService ?? DEFAULT_KEYCHAIN_SERVICE;
  const isMac = platform() === "darwin";

  let mode: "keychain" | "file";
  if (requested === "keychain") {
    if (!isMac) {
      throw new Error(
        "XERO_TOKEN_STORE=keychain is only supported on macOS",
      );
    }
    mode = "keychain";
  } else if (requested === "file") {
    mode = "file";
  } else if (requested === "auto" || requested === "") {
    mode = isMac ? "keychain" : "file";
  } else {
    throw new Error(
      `Unknown XERO_TOKEN_STORE value '${requested}' (expected auto|keychain|file)`,
    );
  }

  if (mode === "file") {
    return new FileTokenStore(filePath, opts.log);
  }

  const keychainStore = new KeychainTokenStore(
    keychainService,
    opts.keychainAccount,
    opts.log,
  );

  await migrateFileToKeychain({
    keychainStore,
    filePath,
    log: opts.log,
  });

  return keychainStore;
}

async function migrateFileToKeychain(args: {
  keychainStore: KeychainTokenStore;
  filePath: string;
  log: TokenStoreLogger;
}): Promise<void> {
  const existing = await args.keychainStore.load();
  if (existing) {
    return;
  }

  let raw: string;
  try {
    raw = await fs.readFile(args.filePath, "utf8");
  } catch {
    return;
  }

  let parsed: PersistedTokens;
  try {
    parsed = JSON.parse(raw) as PersistedTokens;
  } catch {
    args.log.warn(
      `Legacy token file ${args.filePath} is unreadable; skipping migration`,
    );
    return;
  }
  if (!parsed.access_token) {
    return;
  }

  try {
    await args.keychainStore.save(parsed);
    args.log.info(
      `Migrated tokens from ${args.filePath} into the macOS keychain. ` +
        "You can safely delete the file now.",
    );
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    args.log.warn(
      `Failed to migrate tokens to keychain: ${e.stderr?.trim() || e.message}`,
    );
  }
}
