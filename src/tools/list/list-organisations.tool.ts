import { listXeroOrganisations } from "../../handlers/list-xero-organisations.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const ListOrganisationsTool = CreateXeroTool(
  "list-organisations",
  "Lists the Xero organisations (tenants) the current OAuth connection has access to. \
Each entry includes the tenantId, name, type, and whether it is the currently active organisation. \
Use the set-active-organisation tool to switch which organisation subsequent calls operate on.",
  {},
  async () => {
    const response = await listXeroOrganisations();

    if (response.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error fetching organisations: ${response.error}`,
          },
        ],
      };
    }

    const organisations = response.result;

    if (!organisations || organisations.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No organisations available on this OAuth connection.",
          },
        ],
      };
    }

    const summary = `Found ${organisations.length} organisation${organisations.length === 1 ? "" : "s"} on this connection.`;

    const lines = organisations.map((org, index) => {
      const marker = org.isActive ? " [ACTIVE]" : "";
      return [
        `${index + 1}. ${org.tenantName ?? "Unnamed organisation"}${marker}`,
        `   tenantId: ${org.tenantId}`,
        org.tenantType ? `   type: ${org.tenantType}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    });

    return {
      content: [
        {
          type: "text" as const,
          text: summary,
        },
        {
          type: "text" as const,
          text: lines.join("\n\n"),
        },
      ],
    };
  },
);

export default ListOrganisationsTool;
