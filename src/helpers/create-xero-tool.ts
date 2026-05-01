import { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolDefinition } from "../types/tool-definition.js";
import { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { xeroClient } from "../clients/xero-client.js";

function buildActiveOrganisationBlock():
  | { type: "text"; text: string }
  | null {
  const tenantId = xeroClient.tenantId;
  if (!tenantId) {
    return null;
  }
  const tenant = xeroClient.tenants?.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (t: any) => t.tenantId === tenantId,
  );
  const name = tenant?.tenantName ?? "Unknown organisation";
  return {
    type: "text",
    text: `Active organisation: ${name} (tenantId: ${tenantId})`,
  };
}

export const CreateXeroTool =
  <Args extends ZodRawShapeCompat>(
    name: string,
    description: string,
    schema: Args,
    handler: ToolCallback<Args>,
  ): (() => ToolDefinition<ZodRawShapeCompat>) =>
  () => ({
    name: name,
    description: description,
    schema: schema,
    handler: (async (...callArgs: unknown[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (handler as any)(...callArgs);
      const orgBlock = buildActiveOrganisationBlock();

      if (
        !orgBlock ||
        !result ||
        typeof result !== "object" ||
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        !Array.isArray((result as any).content)
      ) {
        return result;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = result as any;
      return {
        ...r,
        content: [orgBlock, ...r.content],
      };
    }) as ToolCallback<Args>,
  });
