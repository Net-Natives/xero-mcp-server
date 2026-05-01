import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

export interface XeroOrganisationConnection {
  tenantId: string;
  tenantName?: string;
  tenantType?: string;
  isActive: boolean;
}

async function getTenantConnections(): Promise<XeroOrganisationConnection[]> {
  await xeroClient.authenticate();
  await xeroClient.updateTenants();

  const tenants = xeroClient.tenants ?? [];
  const activeTenantId = xeroClient.tenantId;

  return tenants.map((tenant) => ({
    tenantId: tenant.tenantId,
    tenantName: tenant.tenantName,
    tenantType: tenant.tenantType,
    isActive: tenant.tenantId === activeTenantId,
  }));
}

/**
 * List the Xero organisations (tenants) that the current OAuth connection
 * has access to.
 */
export async function listXeroOrganisations(): Promise<
  XeroClientResponse<XeroOrganisationConnection[]>
> {
  try {
    const organisations = await getTenantConnections();

    return {
      result: organisations,
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
