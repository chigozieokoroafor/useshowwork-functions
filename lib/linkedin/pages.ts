import type { SocialConnection } from "@prisma/client";
import { linkedInHeaders, providerJson } from "@/lib/publishing/http";
import { requireScopes } from "@/lib/publishing/nativeTokenServices";

export async function linkedInPages(connection: SocialConnection) {
  requireScopes(connection, ["rw_organization_admin", "w_organization_social"]);
  const headers = linkedInHeaders(connection.accessToken!);
  const pages = new Map<string, { id: string; name: string }>();
  for (let start = 0; ; start += 100) {
    if(start>=10000)throw Error('LinkedIn organization lookup exceeded its bounded page limit.');
    const result = await providerJson<{ elements?: { organization: string; state: string; role: string }[] }>(`https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&state=APPROVED&start=${start}&count=100`, { headers });
    const entries = result.elements || [];
    for (const entry of entries) {
      if (entry.state !== "APPROVED" || entry.role !== "ADMINISTRATOR" || !/^urn:li:organization:\d+$/.test(entry.organization) || pages.has(entry.organization)) continue;
      const id = entry.organization.split(":").at(-1)!;
      const page = await providerJson<{ localizedName?: string }>(`https://api.linkedin.com/rest/organizations/${id}`, { headers });
      pages.set(entry.organization, { id: entry.organization, name: page.localizedName || `LinkedIn Page ${id}` });
    }
    if (entries.length < 100) break;
  }
  return [...pages.values()];
}
