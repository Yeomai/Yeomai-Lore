import Link from "next/link";
import { redirect } from "next/navigation";
import type { RepositoryRecord } from "@lore-portal/shared";
import { requirePageUser, serverApi } from "../../lib/api";
import { getI18n } from "../../i18n/server";
import { formatMessage, type Messages } from "../../i18n/messages";
import { CreateOrganizationForm } from "../../components/CreateOrganizationForm";
import { CreateRepositoryForm } from "../../components/CreateRepositoryForm";
import { InviteForm } from "../../components/InviteForm";
import { OrganizationMemberForm } from "../../components/OrganizationMemberForm";
import { OrganizationActions } from "../../components/OrganizationActions";
import { SystemSettingsForm } from "../../components/SystemSettingsForm";
import {
  SmtpSettingsForm,
  type SmtpSettingsView,
} from "../../components/SmtpSettingsForm";
import {
  OAuthIdentityManagement,
  type ManagedOAuthIdentity,
} from "../../components/OAuthIdentityManagement";
import { ChangePasswordForm } from "../../components/ChangePasswordForm";
import { ApiTokensPanel } from "../../components/ApiTokensPanel";
import { DeleteAccountCard } from "../../components/DeleteAccountCard";
import { RepositoryImportPanel } from "../../components/RepositoryImportPanel";
import { RevokeInvitationButton } from "../../components/RevokeInvitationButton";
import { CopyButton } from "../../components/CopyButton";
import { BrowserTimeText } from "../../components/BrowserTime";
import {
  AuditPanel,
  type AuditEvent,
} from "../../components/AuditPanel";
import {
  CertificateSettingsForm,
  type CertificateSettings,
} from "../../components/CertificateSettingsForm";
import {
  DeleteRepositoryDialog,
  RepositoryGrantsDialog,
} from "../../components/RepositoryRiskDialogs";

interface Organization {
  id: string;
  name: string;
  slug: string;
  role: string;
  repositoryCount: number;
}
interface OrganizationWithMembers extends Organization {
  members: Member[];
}
interface Member {
  userId: string;
  username: string;
  email: string;
  displayName: string;
  role: string;
}
interface User {
  id: string;
  email: string;
  username: string;
  displayName: string;
  globalRole: string;
  createdAt: string;
}
interface Invite {
  id: string;
  email: string;
  organizationName: string | null;
  organizationRole: string;
  expiresAt: string;
  inviteUrl: string | null;
}
interface Grant {
  subjectType: "user" | "team";
  subjectId: string;
  subjectName: string;
  permission: "read" | "write" | "admin";
}
interface AccessibleRepository extends RepositoryRecord {
  permission: "read" | "write" | "admin";
  canDelete: boolean;
}
interface RepositoryWithGrants extends AccessibleRepository {
  grants: Grant[];
}

interface SystemInfo {
  webPublicUrl: string;
  lorePublicUrl: string;
  loreReady: boolean;
}

interface ImportJob {
  id: string;
  actorUserId: string;
  actorUsername: string;
  targetRepositoryId: string | null;
  sourceKind: "url";
  sourceValue: string;
  provider: "github" | "gitea";
  includeTags: boolean;
  targetOrganizationSlug: string;
  targetSlug: string;
  sourceDefaultBranch: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  phase:
    | "validating"
    | "mirroring"
    | "scanning"
    | "importing_commits"
    | "creating_refs"
    | "importing_tags"
    | "finalizing"
    | "cleaning_up";
  totalCommits: number;
  importedCommits: number;
  totalBytes: number;
  importedBytes: number;
  errorMessage: string;
  queuePosition: number | null;
  requestedAt: string;
  createdAt: string;
  finishedAt: string | null;
}

const adminSections = [
  "profile",
  "apiTokens",
  "users",
  "invitations",
  "oauthIdentities",
  "organizations",
  "repositories",
  "imports",
  "settings",
  "certificate",
  "smtp",
  "audit",
  "systemInfo",
] as const;
type AdminSection = (typeof adminSections)[number];
const personalSections = new Set<AdminSection>([
  "profile",
  "apiTokens",
  "oauthIdentities",
  "repositories",
  "imports",
]);

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageUser();
  const isAdmin = user.globalRole === "admin";
  const { locale, messages } = await getI18n();
  const meta = await serverApi<{
    webPublicUrl: string;
    userInvitationsEnabled: boolean;
    loreVersion: string;
  }>("/api/v1/meta");
  const canInvite = isAdmin || meta.userInvitationsEnabled;
  const query = await searchParams;
  const requestedValue = one(query.section);
  const requested = requestedValue === "devices" ? "oauthIdentities" : requestedValue;
  const fallbackSection: AdminSection = isAdmin ? "users" : "profile";
  const section: AdminSection = adminSections.includes(
    requested as AdminSection,
  )
    ? (requested as AdminSection)
    : fallbackSection;
  if (
    !isAdmin &&
    !personalSections.has(section) &&
    !(section === "invitations" && canInvite)
  ) {
    redirect(`/admin?section=${fallbackSection}`);
  }
  const needsOrganizations =
    section === "organizations" ||
    section === "repositories" ||
    (section === "invitations" && isAdmin) ||
    section === "imports";
  const organizationsResponse = needsOrganizations
    ? await serverApi<{ organizations: Organization[] }>("/api/v1/orgs")
    : null;
  const organizations = organizationsResponse?.organizations ?? [];
  const organizationsWithMembers: OrganizationWithMembers[] =
    section === "organizations"
      ? await Promise.all(
          organizations.map(async (organization) => ({
            ...organization,
            members: (
              await serverApi<{ members: Member[] }>(
                `/api/v1/orgs/${organization.id}/members`,
              )
            ).members,
          })),
        )
      : [];
  const users =
    section === "users"
      ? (
          await serverApi<{ users: User[] }>("/api/v1/admin/users")
        ).users
      : [];
  const invites =
    section === "invitations"
      ? (
          await serverApi<{ invites: Invite[] }>("/api/v1/admin/invites")
        ).invites
      : [];
  const oauthIdentities =
    section === "oauthIdentities"
      ? (
          await serverApi<{ identities: ManagedOAuthIdentity[] }>(
            "/api/v1/auth/oauth-identities",
          )
        ).identities
      : [];
  const repositoryRows =
    section === "repositories"
      ? (
          await serverApi<{ repositories: AccessibleRepository[] }>(
            "/api/v1/repos",
          )
        ).repositories
      : [];
  const repositories: RepositoryWithGrants[] = await Promise.all(
    repositoryRows.map(async (repository) => {
      const canManage =
        repository.permission === "admin";
      return {
        ...repository,
        grants: canManage
          ? (
              await serverApi<{ grants: Grant[] }>(
                `${repositoryApiPath(repository)}/grants`,
              )
            ).grants
          : [],
      };
    }),
  );
  const auditEvents =
    section === "audit"
      ? (
          await serverApi<{ events: AuditEvent[] }>(
            "/api/v1/admin/audit?limit=50",
          )
        ).events
      : [];
  const systemSettings =
    section === "settings"
      ? await serverApi<{
          userRegistrationEnabled: boolean;
          userInvitationsEnabled: boolean;
        }>(
          "/api/v1/admin/settings",
        )
      : null;
  const systemInfo =
    section === "systemInfo"
      ? await serverApi<SystemInfo>("/api/v1/admin/system-info")
      : null;
  const smtpSettings =
    section === "smtp"
      ? await serverApi<{
          settings: SmtpSettingsView;
          hasPassword: boolean;
        }>("/api/v1/admin/smtp")
      : null;
  const certificateSettings =
    section === "certificate"
      ? await serverApi<CertificateSettings>("/api/v1/admin/certificate")
      : null;
  const importJobs =
    section === "imports"
      ? (
          await serverApi<{ imports: ImportJob[] }>(
            "/api/v1/repository-imports",
          )
        ).imports
      : [];

  return (
    <div className="page-stack">
      <div className="section-heading">
        <div>
          <h1>{sectionTitle(section, messages)}</h1>
        </div>
      </div>

      <div className="admin-workspace">
        <AdminSidebar
          section={section}
          messages={messages}
          isAdmin={isAdmin}
          canInvite={canInvite}
        />
        <div className="admin-content">
          {section === "profile" ? (
            <ProfilePanel user={user} messages={messages} />
          ) : null}
          {section === "apiTokens" ? (
            <ApiTokensPanel locale={locale} messages={messages} />
          ) : null}
          {section === "users" ? (
            <UsersPanel users={users} messages={messages} />
          ) : null}
          {section === "invitations" ? (
            <InvitationsPanel
              organizations={organizations}
              invites={invites}
              locale={locale}
              messages={messages}
              canChooseOrganization={isAdmin}
            />
          ) : null}
          {section === "oauthIdentities" ? (
            <OAuthIdentityManagement
              identities={oauthIdentities}
              authUrl={meta.webPublicUrl}
            />
          ) : null}
          {section === "organizations" ? (
            <OrganizationsPanel
              organizations={organizationsWithMembers}
              currentUserId={user.id}
              messages={messages}
            />
          ) : null}
          {section === "repositories" ? (
            isAdmin ? (
              <RepositoriesPanel
                organizations={organizations}
                repositories={repositories}
                currentUserId={user.id}
                username={user.username}
                messages={messages}
              />
            ) : (
              <PersonalRepositoriesPanel
                organizations={organizations}
                repositories={repositories}
                currentUserId={user.id}
                username={user.username}
                messages={messages}
              />
            )
          ) : null}
          {section === "settings" ? (
            <SystemSettingsForm
              userRegistrationEnabled={
                systemSettings?.userRegistrationEnabled ?? true
              }
              userInvitationsEnabled={
                systemSettings?.userInvitationsEnabled ?? false
              }
              loreVersion={meta.loreVersion}
            />
          ) : null}
          {section === "certificate" && certificateSettings ? (
            <>
              <CertificateSettingsForm settings={certificateSettings} />
              <TransportSecurityNote messages={messages} />
            </>
          ) : null}
          {section === "smtp" && smtpSettings ? (
            <SmtpSettingsForm
              settings={smtpSettings.settings}
              hasPassword={smtpSettings.hasPassword}
            />
          ) : null}
          {section === "imports" ? (
            <RepositoryImportPanel
              organizations={organizations}
              username={user.username}
              imports={importJobs}
              canChooseOrganization={isAdmin}
            />
          ) : null}
          {section === "audit" ? (
            <AuditPanel
              initialEvents={auditEvents}
              locale={locale}
            />
          ) : null}
          {section === "systemInfo" && systemInfo ? (
            <SystemInfoPanel
              info={systemInfo}
              messages={messages}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AdminSidebar({
  section,
  messages,
  isAdmin,
  canInvite,
}: {
  section: AdminSection;
  messages: Messages;
  isAdmin: boolean;
  canInvite: boolean;
}) {
  const m = messages.admin;
  const groups = [
    {
      title: m.accessGroup,
      items: [
        { id: "profile" as const, label: m.profile },
        { id: "apiTokens" as const, label: m.apiTokens },
        ...(isAdmin
          ? [
              { id: "users" as const, label: m.users },
            ]
          : []),
        ...(isAdmin
          ? [
              { id: "organizations" as const, label: m.organizations },
            ]
          : []),
        ...(canInvite
          ? [{ id: "invitations" as const, label: m.invitations }]
          : []),
        { id: "oauthIdentities" as const, label: m.oauthIdentities },
      ],
    },
    {
      title: m.resourcesGroup,
      items: [
        { id: "repositories" as const, label: m.repositories },
        { id: "imports" as const, label: m.imports },
        ...(isAdmin
          ? [
              { id: "certificate" as const, label: m.certificate },
              { id: "smtp" as const, label: m.smtp },
            ]
          : []),
      ],
    },
    ...(isAdmin
      ? [
          {
            title: m.systemGroup,
            items: [
              { id: "settings" as const, label: m.settings },
              { id: "audit" as const, label: m.audit },
              { id: "systemInfo" as const, label: m.systemInfo },
            ],
          },
        ]
      : []),
  ];
  return (
    <aside className="panel admin-sidebar">
      {groups.map((group) => (
        <details className="admin-nav-group" open key={group.title}>
          <summary>{group.title}</summary>
          <nav>
            {group.items.map((item) => (
              <Link
                className={section === item.id ? "active" : ""}
                href={`/admin?section=${item.id}`}
                key={item.id}
              >
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>
        </details>
      ))}
    </aside>
  );
}

function SystemInfoPanel({
  info,
  messages,
}: {
  info: SystemInfo;
  messages: Messages;
}) {
  const m = messages.admin;
  return (
    <section className="panel">
      <div className="system-info-scroll">
        <dl className="profile-details system-info-list">
          <div>
            <dt>{m.webManagementAddress}</dt>
            <dd>
              <code>{info.webPublicUrl}</code>
            </dd>
          </div>
          <div>
            <dt>{m.loreServiceAddress}</dt>
            <dd>
              <code>{info.lorePublicUrl}</code>
            </dd>
          </div>
          <div>
            <dt>{m.serverStatus}</dt>
            <dd>
              <span
                className={`badge ${info.loreReady ? "status-active" : "status-failed"}`}
              >
                {info.loreReady ? m.serverReady : m.serverUnavailable}
              </span>
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function TransportSecurityNote({ messages }: { messages: Messages }) {
  const m = messages.admin;
  return (
    <aside className="system-transport-note">
      <h3>{m.transportSecurityTitle}</h3>
      <p>{m.transportSecurityNote}</p>
      <div className="system-transport-examples">
        <section>
          <h4>{m.transportSecurityAllowed}</h4>
          <pre>
            <code>{`http://localhost:3000
http://127.0.0.1:3000
http://127.0.0.2:3000
http://[::1]:3000`}</code>
          </pre>
        </section>
        <section>
          <h4>{m.transportSecurityDenied}</h4>
          <pre>
            <code>{`http://192.168.0.196:3000
http://lore.intra.company.com`}</code>
          </pre>
        </section>
      </div>
      <div className="system-transport-dns-note">
        <p>{m.transportSecurityDnsRecommendation}</p>
        <pre>
          <code>lore.example.com-&gt; 192.168.x.x</code>
        </pre>
      </div>
    </aside>
  );
}

function UsersPanel({
  users,
  messages,
}: {
  users: User[];
  messages: Messages;
}) {
  const m = messages.admin;
  return (
    <section className="panel">
      <h2>{m.users}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{m.user}</th>
              <th>{m.email}</th>
              <th>{m.role}</th>
              <th>{m.id}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <strong>{user.displayName}</strong>
                  <small>{user.username}</small>
                </td>
                <td>{user.email}</td>
                <td>
                  <span className="badge">
                    {user.globalRole === "admin"
                      ? messages.common.admin
                      : messages.common.userRole}
                  </span>
                </td>
                <td>
                  <code className="small-code">{user.id}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProfilePanel({
  user,
  messages,
}: {
  user: {
    id: string;
    email: string;
    username: string;
    displayName: string;
    globalRole: string;
  };
  messages: Messages;
}) {
  const m = messages.admin;
  return (
    <div className="profile-grid">
      <section className="panel profile-card">
        <div className="profile-avatar" aria-hidden="true">
          {user.displayName.slice(0, 1).toUpperCase()}
        </div>
        <div>
          <p className="eyebrow">{m.profileCard}</p>
          <h2>{user.displayName}</h2>
          <dl className="profile-details">
            <div>
              <dt>{m.username}</dt>
              <dd>{user.username}</dd>
            </div>
            <div>
              <dt>{m.email}</dt>
              <dd>{user.email}</dd>
            </div>
          </dl>
        </div>
      </section>
      <ChangePasswordForm />
      {user.globalRole === "user" ? <DeleteAccountCard /> : null}
    </div>
  );
}

function InvitationsPanel({
  organizations,
  invites,
  locale,
  messages,
  canChooseOrganization,
}: {
  organizations: Organization[];
  invites: Invite[];
  locale: string;
  messages: Messages;
  canChooseOrganization: boolean;
}) {
  const m = messages.admin;
  const availableOrganizations = canChooseOrganization ? organizations : [];
  return (
    <>
      <section className="panel">
        <h2>{m.inviteUser}</h2>
        <InviteForm
          organizations={availableOrganizations.map((org) => ({
            id: org.id,
            name: org.name,
          }))}
          showOrganization={canChooseOrganization}
        />
      </section>
      <section className="panel">
        <h2>{m.pendingInvitations}</h2>
        <div className="simple-list">
          {invites.length === 0 ? (
            <p className="muted">{m.noInvitations}</p>
          ) : (
            invites.map((invite) => (
              <div className="invite-entry" key={invite.id}>
                <div className="invite-entry-main">
                  <div className="invite-entry-details">
                    <strong>{invite.email}</strong>
                    <small>
                      {invite.organizationName ? (
                        <>
                          {invite.organizationName} ·{" "}
                          {roleLabel(invite.organizationRole, messages)}
                        </>
                      ) : (
                        m.platformInvite
                      )}
                    </small>
                  </div>
                  <div className="invite-entry-actions">
                    <span className="muted">
                      <BrowserTimeText
                        template={m.expires}
                        value={invite.expiresAt}
                        locale={locale}
                      />
                    </span>
                    <RevokeInvitationButton inviteId={invite.id} />
                  </div>
                </div>
                {invite.inviteUrl ? (
                  <div className="invite-link-box">
                    <a
                      href={invite.inviteUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {invite.inviteUrl}
                    </a>
                    <CopyButton value={invite.inviteUrl} />
                  </div>
                ) : (
                  <div className="invite-link-unavailable">
                    {m.inviteLinkUnavailable}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </>
  );
}

function OrganizationsPanel({
  organizations,
  currentUserId,
  messages,
}: {
  organizations: OrganizationWithMembers[];
  currentUserId: string;
  messages: Messages;
}) {
  const m = messages.admin;
  return (
    <>
      <section className="panel">
        <p className="eyebrow">{m.organizationCreateEyebrow}</p>
        <h2>{m.createOrganization}</h2>
        <CreateOrganizationForm />
      </section>
      {organizations.length === 0 ? (
        <section className="panel">
          <p className="muted">{m.noOrganizations}</p>
        </section>
      ) : (
        organizations.map((organization) => (
          <section className="panel admin-organization-card" key={organization.id}>
            <div className="section-heading tight">
              <div>
                <h2>{organization.name}</h2>
                <p className="muted">{organization.slug}</p>
              </div>
              <div className="organization-heading-actions">
                <span className="badge">
                  {roleLabel(organization.role, messages)}
                </span>
                <OrganizationActions
                  organization={organization}
                  currentUserId={currentUserId}
                />
              </div>
            </div>
            <h3>{m.organizationMembers}</h3>
            {organization.members.length === 0 ? (
              <p className="muted">{m.noMembers}</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{m.user}</th>
                      <th>{m.email}</th>
                      <th>{m.role}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {organization.members.map((member) => (
                      <tr key={member.userId}>
                        <td>
                          <strong>{member.displayName}</strong>
                          <small>{member.username}</small>
                        </td>
                        <td>{member.email}</td>
                        <td>
                          <span className="badge">
                            {roleLabel(member.role, messages)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <OrganizationMemberForm organizationId={organization.id} />
          </section>
        ))
      )}
    </>
  );
}

function PersonalRepositoriesPanel({
  organizations,
  repositories,
  currentUserId,
  username,
  messages,
}: {
  organizations: Organization[];
  repositories: RepositoryWithGrants[];
  currentUserId: string;
  username: string;
  messages: Messages;
}) {
  const m = messages.admin;
  const manageableRepositories = repositories.filter(
    (repository) => repository.permission === "admin",
  );
  return (
    <>
      <section className="panel">
        <h2>{m.createRepository}</h2>
        <CreateRepositoryForm
          organizations={organizations}
          username={username}
        />
      </section>
      <section className="panel">
        <div className="section-heading">
          <h2>{m.manageableRepositories}</h2>
          <span className="count">{manageableRepositories.length}</span>
        </div>
        {manageableRepositories.length === 0 ? (
          <p className="muted">{m.noRepositories}</p>
        ) : (
          <div className="admin-repository-list">
            {manageableRepositories.map((repository) => {
              const repositoryPath = `/r/${repository.organizationSlug}/${repository.slug}`;
              return (
                <article
                  className="admin-repository-row"
                  key={repository.id}
                >
                  <div>
                    <Link href={repositoryPath}>
                      <strong>
                        {repository.organizationSlug}/{repository.slug}
                      </strong>
                    </Link>
                    <p className="muted">
                      {repository.description || m.noDescription}
                    </p>
                    <small>
                      {repository.defaultBranchName} ·{" "}
                      {messages.status[repository.status]}
                    </small>
                  </div>
                  <RepositoryActions
                    repository={repository}
                    currentUserId={currentUserId}
                    messages={messages}
                  />
                </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

function RepositoriesPanel({
  organizations,
  repositories,
  currentUserId,
  username,
  messages,
}: {
  organizations: Organization[];
  repositories: RepositoryWithGrants[];
  currentUserId: string;
  username: string;
  messages: Messages;
}) {
  const m = messages.admin;
  return (
    <>
      <section className="panel">
        <h2>{m.createRepository}</h2>
        <CreateRepositoryForm
          organizations={organizations}
          username={username}
        />
      </section>
      <section className="panel">
        <div className="section-heading">
          <div className="section-heading-copy">
            <h2>{m.allRepositories}</h2>
            <p className="muted">{m.allRepositoriesHint}</p>
          </div>
          <span className="count">{repositories.length}</span>
        </div>
        {repositories.length === 0 ? (
          <p className="muted">{m.noRepositories}</p>
        ) : (
          <div className="admin-repository-list">
            {repositories.map((repository) => {
              const repositoryPath = `/r/${repository.organizationSlug}/${repository.slug}`;
              return (
                <article className="admin-repository-row" key={repository.id}>
                  <div>
                    <Link href={repositoryPath}>
                      <strong>
                        {repository.organizationSlug}/{repository.slug}
                      </strong>
                    </Link>
                    <p className="muted">
                      {repository.description || m.noDescription}
                    </p>
                    <small>
                      {repository.defaultBranchName} ·{" "}
                      {messages.status[repository.status]}
                    </small>
                  </div>
                  <RepositoryActions
                    repository={repository}
                    currentUserId={currentUserId}
                    messages={messages}
                  />
                </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

function RepositoryActions({
  repository,
  currentUserId,
  messages,
}: {
  repository: RepositoryWithGrants;
  currentUserId: string;
  messages: Messages;
}) {
  const repositoryPath = `/r/${repository.organizationSlug}/${repository.slug}`;
  return (
    <div className="admin-row-actions">
      <Link className="button small" href={repositoryPath}>
        {messages.admin.openRepository}
      </Link>
      {repository.permission === "admin" ? (
        <>
          <RepositoryGrantsDialog
            basePath={repositoryApiPath(repository)}
            grants={repository.grants}
            currentUserId={currentUserId}
            ownerUserId={repository.ownerUserId}
          />
          {repository.canDelete ? (
            <DeleteRepositoryDialog
              basePath={repositoryApiPath(repository)}
              repositoryName={`${repository.organizationSlug}/${repository.slug}`}
              redirectTo="/admin?section=repositories"
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function sectionTitle(section: AdminSection, messages: Messages): string {
  const m = messages.admin;
  switch (section) {
    case "profile":
      return m.profileTitle;
    case "apiTokens":
      return m.apiTokensTitle;
    case "organizations":
      return m.organizationsTitle;
    case "repositories":
      return m.repositoriesTitle;
    case "invitations":
      return m.invitationsTitle;
    case "oauthIdentities":
      return m.oauthIdentitiesTitle;
    case "audit":
      return m.auditTitle;
    case "settings":
      return m.settingsTitle;
    case "certificate":
      return m.certificateTitle;
    case "smtp":
      return m.smtpTitle;
    case "systemInfo":
      return m.systemInfoTitle;
    case "imports":
      return m.importsTitle;
    default:
      return m.title;
  }
}

function roleLabel(role: string, messages: Messages): string {
  switch (role) {
    case "global-admin":
      return messages.common.globalAdmin;
    case "owner":
      return messages.common.owner;
    case "admin":
      return messages.common.admin;
    default:
      return messages.common.member;
  }
}

function repositoryApiPath(
  repository: Pick<RepositoryRecord, "organizationSlug" | "slug">,
): string {
  return `/api/v1/repos/${encodeURIComponent(repository.organizationSlug)}/${encodeURIComponent(repository.slug)}`;
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
