import { reauthenticateXero } from "../../handlers/re-authenticate-xero.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const ReauthenticateTool = CreateXeroTool(
  "re-authenticate",
  "Clear the stored Xero OAuth tokens and run a fresh interactive login. \
Use this if the user wants to switch Xero accounts, or if the current connection has lost permissions and needs to grant them again. \
A browser tab will open for the user to complete the OAuth flow; this tool blocks until login completes (up to 5 minutes). \
Only supported when the server is running in PKCE auth mode.",
  {},
  async () => {
    const response = await reauthenticateXero();

    if (response.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Re-authentication failed: ${response.error}`,
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
            "Re-authentication complete. Stored tokens were cleared and a fresh OAuth login succeeded.",
            `Active organisation: ${active.tenantName ?? "Unnamed organisation"}`,
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

export default ReauthenticateTool;
