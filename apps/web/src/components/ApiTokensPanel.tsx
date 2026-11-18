import { serverApi } from "../lib/api";
import type { Messages } from "../i18n/messages";
import { BrowserTime } from "./BrowserTime";
import { CreateApiTokenForm } from "./CreateApiTokenForm";
import { DeleteApiTokenButton } from "./DeleteApiTokenButton";

interface Token {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export async function ApiTokensPanel({
  locale,
  messages,
}: {
  locale: string;
  messages: Messages;
}) {
  const m = messages.settings;
  const [meta, response] = await Promise.all([
    serverApi<{ loreRemoteUrl: string }>("/api/v1/meta"),
    serverApi<{ tokens: Token[] }>("/api/v1/auth/api-tokens"),
  ]);

  return (
    <div className="api-token-stack">
      <section className="panel">
        <h2>{m.existingTokens}</h2>
        <div className="table-wrap">
          <table className="api-token-table">
            <thead>
              <tr>
                <th>{m.name}</th>
                <th>{m.prefix}</th>
                <th>{m.created}</th>
                <th>{m.lastUsed}</th>
                <th className="token-action-heading">{m.actions}</th>
              </tr>
            </thead>
            <tbody>
              {response.tokens.length === 0 ? (
                <tr>
                    <td colSpan={5} className="muted">
                    {m.noTokens}
                  </td>
                </tr>
              ) : (
                response.tokens.map((token) => (
                  <tr key={token.id}>
                    <td>{token.name}</td>
                    <td>
                      <code>{token.prefix}…</code>
                    </td>
                    <td>
                      <BrowserTime value={token.createdAt} locale={locale} />
                    </td>
                    <td>
                      {token.lastUsedAt
                        ? <BrowserTime value={token.lastUsedAt} locale={locale} />
                        : messages.common.never}
                    </td>
                    <td className="token-action-cell">
                      <DeleteApiTokenButton
                        tokenId={token.id}
                        tokenName={token.name}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="cli-login-row">
          <h3>{m.cliLogin}</h3>
          <pre>
            <code>{`lore auth login ${meta.loreRemoteUrl}`}</code>
          </pre>
        </div>
        <p className="muted">{m.cliHint}</p>
      </section>
      <aside className="panel">
        <h2>{m.createToken}</h2>
        <CreateApiTokenForm />
      </aside>
    </div>
  );
}
