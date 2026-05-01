import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { X509Certificate } from "node:crypto";

const execFileP = promisify(execFile);

const RENEW_THRESHOLD_DAYS = 7;
const RENEW_THRESHOLD_MS = RENEW_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

export interface TLSMaterials {
  cert: Buffer;
  key: Buffer;
  source: "cached" | "mkcert" | "openssl-self-signed";
  certPath: string;
  keyPath: string;
  trusted: boolean;
}

interface CertGenLogger {
  info(message: string): void;
  warn(message: string): void;
}

function defaultCertDir(): string {
  return join(homedir(), ".xero-mcp-server", "certs");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function isCertStillValid(cert: Buffer): boolean {
  try {
    const x509 = new X509Certificate(cert);
    const validTo = new Date(x509.validTo).getTime();
    return validTo - Date.now() > RENEW_THRESHOLD_MS;
  } catch {
    return false;
  }
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileP("/usr/bin/env", ["which", cmd]);
    return true;
  } catch {
    return false;
  }
}

async function generateWithMkcert(
  certPath: string,
  keyPath: string,
  log: CertGenLogger,
): Promise<boolean> {
  if (!(await commandExists("mkcert"))) {
    log.info("mkcert not found on PATH; skipping");
    return false;
  }
  try {
    await execFileP("mkcert", [
      "-cert-file",
      certPath,
      "-key-file",
      keyPath,
      "localhost",
      "127.0.0.1",
    ]);
    log.info(`Generated TLS cert via mkcert at ${certPath}`);
    return true;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    log.warn(
      `mkcert failed: ${e.stderr?.trim() || e.message || "unknown error"}`,
    );
    return false;
  }
}

async function generateSelfSigned(
  certPath: string,
  keyPath: string,
  log: CertGenLogger,
): Promise<void> {
  if (!(await commandExists("openssl"))) {
    throw new Error(
      "Cannot generate TLS cert: neither mkcert nor openssl is available on PATH",
    );
  }
  await execFileP("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "365",
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  log.info(`Generated self-signed TLS cert via openssl at ${certPath}`);
}

/**
 * Resolve TLS materials for the local OAuth callback listener.
 *
 * Strategy:
 *   1. If cached cert at <certDir> is present and not within RENEW_THRESHOLD_DAYS
 *      of expiry, reuse it.
 *   2. Otherwise try mkcert (browser-trusted if `mkcert -install` was run).
 *   3. Otherwise fall back to an openssl self-signed cert (browser will warn
 *      until user clicks through).
 */
export async function ensureLocalhostTLS(
  log: CertGenLogger,
  certDir: string = defaultCertDir(),
): Promise<TLSMaterials> {
  await fs.mkdir(certDir, { recursive: true });
  const certPath = join(certDir, "cert.pem");
  const keyPath = join(certDir, "key.pem");

  const cached =
    (await fileExists(certPath)) && (await fileExists(keyPath));
  if (cached) {
    const cert = await fs.readFile(certPath);
    const key = await fs.readFile(keyPath);
    if (isCertStillValid(cert)) {
      return {
        cert,
        key,
        source: "cached",
        certPath,
        keyPath,
        trusted: false,
      };
    }
    log.info("Cached TLS cert is expiring or invalid; regenerating");
  }

  const usedMkcert = await generateWithMkcert(certPath, keyPath, log);
  if (!usedMkcert) {
    await generateSelfSigned(certPath, keyPath, log);
  }
  await fs.chmod(keyPath, 0o600).catch(() => {
    /* best-effort */
  });

  const cert = await fs.readFile(certPath);
  const key = await fs.readFile(keyPath);
  return {
    cert,
    key,
    source: usedMkcert ? "mkcert" : "openssl-self-signed",
    certPath,
    keyPath,
    trusted: usedMkcert,
  };
}
