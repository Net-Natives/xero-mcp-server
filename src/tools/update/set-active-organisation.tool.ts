import { z } from "zod";
import { setActiveXeroOrganisation } from "../../handlers/set-active-xero-organisation.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const SetActiveOrganisationTool = CreateXeroTool(
  "set-active-organisation",
  "Switch the active Xero organisation (tenant) used for subsequent API calls in this session. \
Pass the tenantId of one of the organisations returned by the list-organisations tool. \
The change persists for the lifetime of the running MCP server process.",
  {
    tenantId: z
      .string()
      .describe(
        "The tenantId of the Xero organisation to make active. Obtain this from the list-organisations tool.",
      ),
  },
  async ({ tenantId }: { tenantId: string }) => {
    const response = await setActiveXeroOrganisation(tenantId);

    if (response.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error switching active organisation: ${response.error}`,
          },
        ],
      };
    }

    const active = response.result;

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Active organisation set to: ${active.tenantName ?? "Unnamed organisation"}`,
            `tenantId: ${active.tenantId}`,
            active.tenantType ? `type: ${active.tenantType}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
  },
);

export default SetActiveOrganisationTool;
