import { xeroClient } from "../clients/xero-client.js";
import { PkceXeroClient } from "../clients/pkce-xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export interface ReauthenticateResult {
  tenantId: string;
  tenantName?: string;
  tenantType?: string;
}

/**
 * Wipe stored OAuth tokens and force a fresh PKCE login. Only meaningful
 * for the PKCE auth mode — Bearer and Custom Connections modes don't have
 * stored credentials to clear.
 */
export async function reauthenticateXero(): Promise<
  XeroClientResponse<ReauthenticateResult>
> {
  if (!(xeroClient instanceof PkceXeroClient)) {
    return {
      result: null,
      isError: true,
      error:
        "Re-authentication is only supported when XERO_AUTH_MODE=pkce. Other auth modes do not persist credentials to clear.",
    };
  }

  try {
    await xeroClient.forceReauthenticate();

    const tenant = xeroClient.tenants?.find(
      (t) => t.tenantId === xeroClient.tenantId,
    );

    return {
      result: {
        tenantId: xeroClient.tenantId,
        tenantName: tenant?.tenantName,
        tenantType: tenant?.tenantType,
      },
      isError: false,
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
