import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export interface ActiveXeroOrganisation {
  tenantId: string;
  tenantName?: string;
  tenantType?: string;
}

async function activateTenant(
  tenantId: string,
): Promise<ActiveXeroOrganisation> {
  await xeroClient.setActiveTenant(tenantId);

  const tenant = xeroClient.tenants?.find(
    (t) => t.tenantId === tenantId,
  );

  return {
    tenantId,
    tenantName: tenant?.tenantName,
    tenantType: tenant?.tenantType,
  };
}

/**
 * Switch the active Xero tenant (organisation) used for subsequent
 * API calls in this server session.
 */
export async function setActiveXeroOrganisation(
  tenantId: string,
): Promise<XeroClientResponse<ActiveXeroOrganisation>> {
  try {
    const active = await activateTenant(tenantId);

    return {
      result: active,
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
