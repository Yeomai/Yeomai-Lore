"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { localizeApiError } from "../i18n/messages";

interface DirectoryUser {
  id: string;
  username: string;
  displayName: string;
}

export function GrantAccessForm({ basePath }: { basePath: string }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DirectoryUser[]>([]);
  const [selected, setSelected] = useState<DirectoryUser | null>(null);
  const [searching, setSearching] = useState(false);
  const { messages } = useI18n();
  const m = messages.grantForm;

  useEffect(() => {
    const value = query.trim();
    if (value.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const response = await clientApi<{ users: DirectoryUser[] }>(
          `/api/v1/auth/users/search?q=${encodeURIComponent(value)}`,
          { signal: controller.signal },
        );
        setResults(response.users);
      } catch (cause) {
        if ((cause as Error).name !== "AbortError") {
          setError(localizeApiError(cause, messages));
        }
      } finally {
        if (!controller.signal.aborted) {
          setSearching(false);
        }
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [messages, query]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const formElement = event.currentTarget;
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await clientApi(`${basePath}/grants`, {
        method: "POST",
        body: JSON.stringify({
          subjectType: "user",
          subjectId: selected.id,
          permission: form.get("permission"),
        }),
      });
      setQuery("");
      setResults([]);
      setSelected(null);
      formElement.closest("dialog")?.close();
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="stack compact" onSubmit={submit}>
      <label>
        {m.searchUser}
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(null);
            setError("");
          }}
          placeholder={m.searchUserPlaceholder}
          autoComplete="off"
        />
      </label>
      {selected ? (
        <div className="selected-grant-user">
          <div>
            <strong>{selected.displayName}</strong>
            <small>{selected.username}</small>
          </div>
          <button
            className="button small"
            type="button"
            onClick={() => {
              setSelected(null);
              setQuery("");
            }}
          >
            {m.changeUser}
          </button>
        </div>
      ) : (
        <div className="grant-user-results" role="listbox">
          {searching ? <p className="muted">{m.searchingUsers}</p> : null}
          {!searching && query.trim().length >= 2 && results.length === 0 ? (
            <p className="muted">{m.noUsersFound}</p>
          ) : null}
          {results.map((user) => (
            <button
              className="grant-user-result"
              type="button"
              role="option"
              aria-selected={false}
              key={user.id}
              onClick={() => {
                setSelected(user);
                setQuery(user.username);
                setResults([]);
              }}
            >
              <strong>{user.displayName}</strong>
              <small>{user.username}</small>
            </button>
          ))}
        </div>
      )}
      <label>
        {m.permission}
        <select name="permission" defaultValue="read">
          <option value="read">{m.read}</option>
          <option value="write">{m.write}</option>
          <option value="admin">{m.admin}</option>
        </select>
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <button
        className={`button ${pending ? "is-pending" : ""}`}
        disabled={pending || !selected}
      >
        {pending ? m.saving : m.submit}
      </button>
    </form>
  );
}
