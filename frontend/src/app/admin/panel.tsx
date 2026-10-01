"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  CheckCheck,
  Copy,
  FileText,
  KeyRound,
  LoaderCircle,
  LogOut,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import type { DocumentKind } from "@/lib/types";

type Rules = {
  mode: "all" | "optional" | "exact";
  documents: DocumentKind[];
  requiredDocuments: DocumentKind[];
  count?: number;
};
type Application = {
  id: string;
  name: string;
  enabled: boolean;
  version: number;
  rules: Rules;
  webhookUrl: string | null;
  returnUrl: string | null;
  webhookConfigured: boolean;
  imported: boolean;
  createdAt: string;
};
type Key = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
};
type Catalog = {
  gatewayReachable: boolean;
  documents: Array<{ id: DocumentKind; title: string; available: boolean; sides: string[] }>;
  unsupportedDocuments: Array<{ id: string; title: string }>;
};
type User = { name: string; email: string };
const defaultRules: Rules = {
  mode: "exact",
  documents: ["dz-id", "dz-driving-licence", "dz-passport"],
  requiredDocuments: [],
  count: 2,
};

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new RequestError(
      response.status,
      payload.detail ??
        payload.message ??
        String(payload.error ?? "The request failed. Try again.").replaceAll("_", " "),
    );
  return payload;
}

export function AdminPanel() {
  const [user, setUser] = useState<User | null>();
  const [applications, setApplications] = useState<Application[]>([]);
  const [catalog, setCatalog] = useState<Catalog>();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [newWebhookSecret, setNewWebhookSecret] = useState<string>();
  const refresh = useCallback(async () => {
    const data = await api<{ user: User }>("/api/admin/session");
    setUser(data.user);
    const [list, documents] = await Promise.all([
      api<{ applications: Application[] }>("/api/admin/applications"),
      api<Catalog>("/api/admin/catalog"),
    ]);
    setApplications(list.applications);
    setCatalog(documents);
  }, []);
  useEffect(() => {
    refresh().catch((cause) => {
      if (cause instanceof RequestError && cause.status === 401) setUser(null);
      else {
        setUser(null);
        setError(cause.message);
      }
    });
  }, [refresh]);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    try {
      await api("/api/auth/sign-in/email", "POST", {
        email: data.get("email"),
        password: data.get("password"),
        rememberMe: false,
      });
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    try {
      await api("/api/auth/sign-out", "POST", {});
      setUser(null);
      setApplications([]);
      setSelected(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (user === undefined)
    return (
      <main className="console-login">
        <LoaderCircle className="console-spin" aria-label="Loading administration" />
      </main>
    );
  if (!user)
    return (
      <main className="console-login">
        <div className="console-login-form">
          <a className="console-brand" href="/">
            <span className="console-mark">
              <FileText size={18} />
            </span>
            OCR Onboarding
          </a>
          <h1>Administration</h1>
          <p>Sign in to manage application access and document requirements.</p>
          <form onSubmit={login}>
            <label>
              Email address
              <input name="email" type="email" autoComplete="username" required />
            </label>
            <label>
              Password
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            {error && (
              <p className="console-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="console-primary" disabled={busy}>
              {busy ? <LoaderCircle className="console-spin" size={16} /> : <ArrowRight size={16} />} Sign in
            </button>
          </form>
          <div className="console-login-foot">
            <ShieldCheck size={15} /> Administrator accounts are provisioned by your team.
          </div>
          <a className="console-text-link" href="/docs">
            Read the API documentation <ArrowRight size={14} />
          </a>
        </div>
        <aside className="console-login-aside">
          <div>
            <h2>
              One integration.
              <br />
              Your document rules.
            </h2>
            <p>Give each application a secure connection and a clear collection journey.</p>
            <ol>
              <li>Register an application</li>
              <li>Define its document requirements</li>
              <li>Issue a key and connect its backend</li>
            </ol>
          </div>
        </aside>
      </main>
    );
  const active = applications.find((application) => application.id === selected);
  return (
    <div className="console-shell">
      <aside className="console-sidebar">
        <a className="console-brand" href="/admin">
          <span className="console-mark">
            <FileText size={18} />
          </span>
          OCR Onboarding
        </a>
        <nav>
          <span className="console-nav-active">
            <KeyRound size={17} /> Applications
          </span>
          <a href="/docs">
            <BookOpen size={17} /> API documentation <ArrowRight size={14} />
          </a>
        </nav>
        <div className="console-sidebar-bottom">
          <span>{user.email}</span>
          <button type="button" onClick={() => void logout()} disabled={busy}>
            <LogOut size={15} /> Sign out
          </button>
        </div>
      </aside>
      <main className="console-main">
        <header className="console-page-head">
          <div>
            <h1>Applications</h1>
            <p>Manage access and define what each application needs to collect.</p>
          </div>
          <button
            type="button"
            className="console-primary"
            onClick={() => {
              setCreating(true);
              setSelected(null);
              setNotice(undefined);
              setNewWebhookSecret(undefined);
            }}
          >
            <Plus size={17} /> New application
          </button>
        </header>
        {notice && (
          <div className="console-notice" aria-live="polite">
            <Check size={16} />
            {notice}
            <button type="button" aria-label="Dismiss notification" onClick={() => setNotice(undefined)}>
              <X size={15} />
            </button>
          </div>
        )}
        {error && (
          <div className="console-error" role="alert">
            {error}
            <button
              type="button"
              className="console-text-link"
              onClick={() =>
                void refresh()
                  .then(() => setError(undefined))
                  .catch((cause) => setError(cause.message))
              }
            >
              Retry
            </button>
          </div>
        )}
        <div className="console-app-layout">
          <section className="console-app-list" aria-label="Registered applications">
            <div className="console-list-head">
              <h2>Registered applications</h2>
              <span>{applications.length}</span>
            </div>
            {applications.map((application) => (
              <button
                type="button"
                key={application.id}
                className={`console-app-item ${selected === application.id ? "is-selected" : ""}`}
                onClick={() => {
                  setSelected(application.id);
                  setCreating(false);
                  setNotice(undefined);
                  setNewWebhookSecret(undefined);
                }}
              >
                <span className="console-app-avatar">{application.name.slice(0, 1).toUpperCase()}</span>
                <span>
                  <strong>{application.name}</strong>
                  <small>
                    {application.rules.mode === "all"
                      ? "All documents required"
                      : application.rules.mode === "exact"
                        ? `Exactly ${application.rules.count} documents`
                        : "Required and optional documents"}
                  </small>
                </span>
                <span
                  className={`console-status-dot ${application.enabled ? "" : "off"}`}
                  role="img"
                  aria-label={application.enabled ? "Active" : "Disabled"}
                />
              </button>
            ))}
            {!applications.length && (
              <div className="console-empty-small">
                <p>No applications yet.</p>
                <p>Create one to issue its first API key.</p>
              </div>
            )}
          </section>
          {creating || active ? (
            <ApplicationEditor
              key={active?.id ?? "new"}
              application={active}
              catalog={catalog}
              onRefreshCatalog={async () => setCatalog(await api<Catalog>("/api/admin/catalog"))}
              initialSecret={newWebhookSecret}
              onSaved={async (application, signingSecret) => {
                setNewWebhookSecret(signingSecret);
                await refresh();
                setSelected(application.id);
                setCreating(false);
                setNotice("Application saved. New sessions will use these document rules.");
              }}
            />
          ) : (
            <section className="console-empty">
              <div className="console-empty-symbol">
                <KeyRound size={28} />
              </div>
              <h2>Select an application</h2>
              <p>Manage its API keys, document rules and completion destinations in one place.</p>
              <button type="button" className="console-secondary" onClick={() => setCreating(true)}>
                <Plus size={16} /> Create an application
              </button>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

function ApplicationEditor({
  application,
  catalog,
  onSaved,
  onRefreshCatalog,
  initialSecret,
}: {
  application?: Application;
  catalog?: Catalog;
  onSaved: (application: Application, signingSecret?: string) => Promise<void>;
  initialSecret?: string;
  onRefreshCatalog: () => Promise<void>;
}) {
  const [name, setName] = useState(application?.name ?? "");
  const [enabled, setEnabled] = useState(application?.enabled ?? true);
  const [rules, setRules] = useState<Rules>(application?.rules ?? defaultRules);
  const [mode, setMode] = useState(
    application?.rules.mode === "exact" && application.rules.requiredDocuments.length
      ? "exact-required"
      : (application?.rules.mode ?? "exact"),
  );
  const [webhookUrl, setWebhookUrl] = useState(application?.webhookUrl ?? "");
  const [returnUrl, setReturnUrl] = useState(application?.returnUrl ?? "");
  const [keys, setKeys] = useState<Key[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [secret, setSecret] = useState<{ title: string; value: string }>();
  const [copied, setCopied] = useState(false);
  const [revoke, setRevoke] = useState<string>();
  const [keyName, setKeyName] = useState("");
  const [keyExpiry, setKeyExpiry] = useState("");
  useEffect(() => {
    if (application)
      api<{ keys: Key[] }>(`/api/admin/applications/${application.id}/keys`)
        .then((data) => setKeys(data.keys))
        .catch((cause) => setError(cause.message));
  }, [application]);
  useEffect(() => {
    if (initialSecret) setSecret({ title: "Webhook signing secret", value: initialSecret });
  }, [initialSecret]);
  async function action(task: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await task();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function changeMode(value: string) {
    setMode(value);
    setRules({
      ...rules,
      mode: value === "exact-required" ? "exact" : (value as Rules["mode"]),
      requiredDocuments: value === "exact" || value === "all" ? [] : rules.requiredDocuments,
      count: Math.min(rules.count ?? 2, rules.documents.length || 1),
    });
  }
  const invalidCount =
    rules.mode === "exact" &&
    (!rules.count || rules.count > rules.documents.length || rules.count < rules.requiredDocuments.length);
  const ruleChanged = !application || JSON.stringify(rules) !== JSON.stringify(application.rules);
  const unavailable =
    ruleChanged &&
    (!catalog?.gatewayReachable ||
      rules.documents.some((id) => !catalog.documents.find((entry) => entry.id === id)?.available));
  const ruleSummary =
    rules.mode === "all"
      ? `All ${rules.documents.length} selected documents are mandatory.`
      : rules.mode === "exact"
        ? `Collect exactly ${rules.count ?? 0} documents, including ${rules.requiredDocuments.length} mandatory.`
        : `Collect at least ${Math.max(1, rules.requiredDocuments.length)} document${rules.requiredDocuments.length > 1 ? "s" : ""}; the rest are optional.`;
  async function save(event: FormEvent) {
    event.preventDefault();
    await action(async () => {
      const result = await api<{ application: Application; webhookSecret: string | null }>(
        application ? `/api/admin/applications/${application.id}` : "/api/admin/applications",
        application ? "PUT" : "POST",
        {
          name,
          enabled,
          rules,
          webhookUrl: webhookUrl || null,
          returnUrl: returnUrl || null,
          ...(application ? { version: application.version } : {}),
        },
      );
      await onSaved(result.application, result.webhookSecret ?? undefined);
      if (result.webhookSecret) setSecret({ title: "Webhook signing secret", value: result.webhookSecret });
    });
  }
  async function createKey(event: FormEvent) {
    event.preventDefault();
    if (!application) return;
    await action(async () => {
      const result = await api<Key & { key: string }>(`/api/admin/applications/${application.id}/keys`, "POST", {
        name: keyName,
        expiresAt: keyExpiry ? new Date(keyExpiry).toISOString() : null,
      });
      setSecret({ title: "New API key", value: result.key });
      setCopied(false);
      setKeyName("");
      setKeyExpiry("");
      setKeys((await api<{ keys: Key[] }>(`/api/admin/applications/${application.id}/keys`)).keys);
    });
  }
  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret.value);
      setCopied(true);
    } catch {
      setError("Clipboard access failed. Select and copy the secret below.");
    }
  }
  return (
    <section className="console-editor">
      <header className="console-editor-head">
        <h2>{application ? application.name : "New application"}</h2>
        {application && <span className="console-badge">Version {application.version}</span>}
      </header>
      {application && (
        <p className="console-app-id">
          Application ID <code>{application.id}</code>
        </p>
      )}
      {application?.imported && (
        <p className="console-help">
          Existing credentials were imported. Saving this application assigns the document rules below to all its new
          sessions.
        </p>
      )}
      {error && (
        <div className="console-error" role="alert">
          {error}
        </div>
      )}
      {secret && (
        <div className="console-secret" aria-live="polite">
          <div>
            <strong>{secret.title}</strong>
            <button type="button" aria-label="Dismiss secret" onClick={() => setSecret(undefined)}>
              <X size={16} />
            </button>
          </div>
          <p>Copy it now. The full value will not be shown again.</p>
          <code>{secret.value}</code>
          <button type="button" className="console-secondary" onClick={() => void copySecret()}>
            {copied ? <CheckCheck size={15} /> : <Copy size={15} />}
            {copied ? "Copied" : "Copy secret"}
          </button>
        </div>
      )}
      <form onSubmit={save}>
        <div className="console-form-grid">
          <label>
            Application name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Your application name"
              required
              minLength={2}
              maxLength={100}
            />
          </label>
          <label>
            Status
            <select
              value={enabled ? "active" : "disabled"}
              onChange={(event) => setEnabled(event.target.value === "active")}
            >
              <option value="active">Active</option>
              <option value="disabled">Disabled — all API access blocked</option>
            </select>
          </label>
        </div>
        <fieldset className="console-section">
          <legend>Document requirements</legend>
          <p className="console-help">
            Choose a collection rule, then include documents from the compatible gateway catalog.
          </p>
          <div className="console-rule-options">
            {[
              { value: "all", title: "All required", description: "Every selected document must be provided." },
              {
                value: "optional",
                title: "Required + optional",
                description: "Collect mandatory documents; others are optional.",
              },
              { value: "exact", title: "Exact count", description: "Let the person choose a fixed number." },
              {
                value: "exact-required",
                title: "Exact count + required",
                description: "A fixed number, including mandatory documents.",
              },
            ].map((option) => (
              <label key={option.value} className={mode === option.value ? "is-selected" : ""}>
                <input
                  type="radio"
                  name="collection-rule"
                  checked={mode === option.value}
                  onChange={() => changeMode(option.value)}
                />
                <span>
                  <strong>{option.title}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
          </div>
          {rules.mode === "exact" && (
            <label className="console-count">
              Total documents to collect
              <input
                type="number"
                min={Math.max(1, rules.requiredDocuments.length)}
                max={rules.documents.length || 1}
                value={rules.count ?? 1}
                onChange={(event) => setRules({ ...rules, count: Number(event.target.value) })}
                required
              />
              <small>The count includes mandatory documents.</small>
            </label>
          )}
          <div className="console-document-list">
            {(catalog?.documents ?? []).map((document) => {
              const included = rules.documents.includes(document.id);
              return (
                <div className="console-document-row" key={document.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={included}
                      disabled={!document.available && !included}
                      onChange={() =>
                        setRules({
                          ...rules,
                          documents: included
                            ? rules.documents.filter((id) => id !== document.id)
                            : [...rules.documents, document.id],
                          requiredDocuments: included
                            ? rules.requiredDocuments.filter((id) => id !== document.id)
                            : rules.requiredDocuments,
                        })
                      }
                    />
                    <span>
                      <strong>{document.title}</strong>
                      <small>
                        {document.sides.length === 2 ? "Front and back · one document" : "Identity page · one document"}
                        {!document.available && " · Gateway unavailable"}
                      </small>
                    </span>
                  </label>
                  {included && (mode === "optional" || mode === "exact-required") ? (
                    <select
                      aria-label={`${document.title} requirement`}
                      value={rules.requiredDocuments.includes(document.id) ? "required" : "optional"}
                      onChange={(event) =>
                        setRules({
                          ...rules,
                          requiredDocuments:
                            event.target.value === "required"
                              ? [...rules.requiredDocuments, document.id]
                              : rules.requiredDocuments.filter((id) => id !== document.id),
                        })
                      }
                    >
                      <option value="optional">Optional</option>
                      <option value="required">Required</option>
                    </select>
                  ) : included && rules.mode === "all" ? (
                    <span className="console-badge">Required</span>
                  ) : null}
                </div>
              );
            })}
          </div>
          {!catalog?.gatewayReachable && (
            <div className="console-error" role="alert">
              The gateway catalog could not be loaded. Existing rules remain active.
              <button
                type="button"
                className="console-text-link"
                disabled={busy}
                onClick={() => void action(onRefreshCatalog)}
              >
                <RefreshCw size={14} /> Retry connection
              </button>
            </div>
          )}
          {Boolean(catalog?.unsupportedDocuments.length) && (
            <details className="console-catalog-details">
              <summary>{catalog?.unsupportedDocuments.length} gateway documents need an onboarding adapter</summary>
              <p>These document types are readable by the gateway but are not yet supported by the capture journey.</p>
              <ul>
                {catalog?.unsupportedDocuments.map((document) => (
                  <li key={document.id}>
                    {document.title} <code>{document.id}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className={`console-rule-summary ${invalidCount || !rules.documents.length ? "is-invalid" : ""}`}>
            <ShieldCheck size={17} />
            <span>
              {ruleSummary}
              {invalidCount && " Choose a count that fits the list and includes all mandatory documents."}
            </span>
          </div>
        </fieldset>
        <fieldset className="console-section">
          <legend>Completion destinations</legend>
          <p className="console-help">Notify the application's backend and bring the person back to its interface.</p>
          <label>
            Webhook URL
            <input
              type="url"
              value={webhookUrl}
              onChange={(event) => setWebhookUrl(event.target.value)}
              placeholder="https://your-app.example/webhooks/onboarding"
            />
            <small>Signed completion notifications. Leave empty to use status polling.</small>
          </label>
          <label>
            Return URL
            <input
              type="url"
              value={returnUrl}
              onChange={(event) => setReturnUrl(event.target.value)}
              placeholder="https://your-app.example/onboarding/complete"
            />
            <small>Navigation only. The application verifies the result through its backend.</small>
          </label>
          {application?.webhookConfigured && (
            <button
              type="button"
              className="console-text-link"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const result = await api<{ secret: string; application: Application }>(
                    `/api/admin/applications/${application.id}/webhook-secret`,
                    "POST",
                    {},
                  );
                  await onSaved(result.application, result.secret);
                  setSecret({ title: "New webhook signing secret", value: result.secret });
                })
              }
            >
              Replace webhook signing secret
            </button>
          )}
        </fieldset>
        <footer className="console-form-footer">
          <p>Changes apply to new sessions. Existing sessions keep their configuration.</p>
          <button
            type="submit"
            className="console-primary"
            disabled={busy || invalidCount || !rules.documents.length || unavailable}
          >
            {busy ? <LoaderCircle className="console-spin" size={16} /> : <Check size={16} />}
            {application ? "Save changes" : "Create application"}
          </button>
        </footer>
      </form>
      {application && (
        <section className="console-section console-keys">
          <h3>API keys</h3>
          <p className="console-help">
            Issue a key to this application's backend. Keep it out of browser and mobile code.
          </p>
          <form onSubmit={createKey} className="console-key-form">
            <label>
              Key name
              <input
                required
                minLength={2}
                maxLength={80}
                value={keyName}
                onChange={(event) => setKeyName(event.target.value)}
                placeholder="Production backend"
              />
            </label>
            <label>
              Expiration <span className="console-optional">optional</span>
              <input type="datetime-local" value={keyExpiry} onChange={(event) => setKeyExpiry(event.target.value)} />
            </label>
            <button type="submit" className="console-secondary" disabled={busy}>
              <Plus size={16} /> Generate key
            </button>
          </form>
          <div className="console-key-list">
            {keys.map((key) => (
              <div className="console-key-row" key={key.id}>
                <KeyRound size={17} />
                <div>
                  <strong>{key.name}</strong>
                  <code>{key.prefix}…</code>
                  <small>
                    {key.revokedAt
                      ? "Revoked"
                      : key.expiresAt && new Date(key.expiresAt) < new Date()
                        ? "Expired"
                        : "Active"}{" "}
                    · Created {new Date(key.createdAt).toLocaleDateString("en-GB")}
                    {key.lastUsedAt && ` · Last used ${new Date(key.lastUsedAt).toLocaleDateString("en-GB")}`}
                  </small>
                </div>
                {!key.revokedAt &&
                  (revoke === key.id ? (
                    <div className="console-revoke-confirm">
                      <span>Revoke this key now?</span>
                      <button
                        type="button"
                        className="console-danger-button"
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await api(`/api/admin/applications/${application.id}/keys/${key.id}`, "DELETE");
                            setKeys(
                              (await api<{ keys: Key[] }>(`/api/admin/applications/${application.id}/keys`)).keys,
                            );
                            setRevoke(undefined);
                          })
                        }
                      >
                        Revoke
                      </button>
                      <button type="button" className="console-text-link" onClick={() => setRevoke(undefined)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="console-icon-button"
                      aria-label={`Revoke ${key.name}`}
                      onClick={() => setRevoke(key.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  ))}
              </div>
            ))}
            {!keys.length && <p className="console-help">No keys issued. Generate one to connect this application.</p>}
          </div>
        </section>
      )}
    </section>
  );
}
