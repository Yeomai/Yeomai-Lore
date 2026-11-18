import { redirect } from "next/navigation";
import {
  isServiceReady,
  requirePageUser,
  serverApi,
} from "../../lib/api";
import { getI18n } from "../../i18n/server";
import { formatMessage } from "../../i18n/messages";
import {
  DashboardRepositories,
  type DashboardRepository,
  type DashboardOrganization,
} from "../../components/DashboardRepositories";

interface Organization {
  id: string;
  slug: string;
  name: string;
  role: string;
}

export default async function DashboardPage() {
  const user = await requirePageUser();
  if (!(await isServiceReady())) {
    redirect("/starting");
  }
  const { locale, messages } = await getI18n();
  const m = messages.dashboard;
  const [repositoriesResponse, organizationsResponse] = await Promise.all([
    serverApi<{ repositories: DashboardRepository[] }>("/api/v1/repos"),
    serverApi<{ organizations: Organization[] }>("/api/v1/orgs"),
  ]);
  const repositories = repositoriesResponse.repositories;
  const organizations = organizationsResponse.organizations;

  return (
    <div className="page-stack">
      <section className="hero">
        <div>
          <h1>{formatMessage(m.greeting, { name: user.displayName })}</h1>
        </div>
        <div className="stat-grid">
          <div className="stat">
            <strong>{repositories.length}</strong>
            <span>{m.visibleRepositories}</span>
          </div>
          <div className="stat">
            <strong>{organizations.length}</strong>
            <span>
              {user.globalRole === "admin"
                ? m.manageableOrganizations
                : m.organizations}
            </span>
          </div>
        </div>
      </section>

      <DashboardRepositories
        repositories={repositories}
        organizations={organizations}
        userId={user.id}
        username={user.username}
        locale={locale}
        messages={messages}
      />
    </div>
  );
}

