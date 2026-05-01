import { IXeroClientConfig, Organisation, XeroClient } from "xero-node";

import { ensureError } from "../helpers/ensure-error.js";

export abstract class MCPXeroClient extends XeroClient {
  public tenantId: string;
  private selectedTenantId: string | null;
  private shortCode: string;

  protected constructor(config?: IXeroClientConfig) {
    super(config);
    this.tenantId = "";
    this.selectedTenantId = null;
    this.shortCode = "";
  }

  public abstract authenticate(): Promise<void>;

  protected resolveActiveTenantId(availableTenantIds: string[]): string {
    if (
      this.selectedTenantId &&
      availableTenantIds.includes(this.selectedTenantId)
    ) {
      return this.selectedTenantId;
    }
    return availableTenantIds[0] ?? "";
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async updateTenants(fullOrgDetails?: boolean): Promise<any[]> {
    await super.updateTenants(fullOrgDetails);
    if (this.tenants && this.tenants.length > 0) {
      this.tenantId = this.resolveActiveTenantId(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.tenants.map((t: any) => t.tenantId),
      );
    }
    return this.tenants;
  }

  public clearActiveTenant(): void {
    this.tenantId = "";
    this.selectedTenantId = null;
    this.shortCode = "";
  }

  public async setActiveTenant(tenantId: string): Promise<void> {
    await this.authenticate();

    if (!this.tenants || this.tenants.length === 0) {
      await this.updateTenants();
    }

    const tenant = this.tenants?.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t: any) => t.tenantId === tenantId,
    );

    if (!tenant) {
      throw new Error(
        `Tenant ${tenantId} is not available on this OAuth connection`,
      );
    }

    this.selectedTenantId = tenantId;
    this.tenantId = tenantId;
    this.shortCode = "";
  }

  public getActiveTenant(): { tenantId: string; tenantName?: string } | null {
    if (!this.tenantId) {
      return null;
    }
    const tenant = this.tenants?.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (t: any) => t.tenantId === this.tenantId,
    );
    return {
      tenantId: this.tenantId,
      tenantName: tenant?.tenantName,
    };
  }

  private async getOrganisation(): Promise<Organisation> {
    await this.authenticate();

    const organisationResponse = await this.accountingApi.getOrganisations(
      this.tenantId || "",
    );

    const organisation = organisationResponse.body.organisations?.[0];

    if (!organisation) {
      throw new Error("Failed to retrieve organisation");
    }

    return organisation;
  }

  public async getShortCode(): Promise<string | undefined> {
    if (!this.shortCode) {
      try {
        const organisation = await this.getOrganisation();
        this.shortCode = organisation.shortCode ?? "";
      } catch (error: unknown) {
        const err = ensureError(error);

        throw new Error(
          `Failed to get Organisation short code: ${err.message}`,
        );
      }
    }
    return this.shortCode;
  }
}
