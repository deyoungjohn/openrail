"use client";

import type { ApiKey, ApiKeyCreated, WebhookEndpoint } from "@openrail/api-client";
import { Plus, RotateCw, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { copy } from "@/copy";
import { dashClient } from "@/lib/client";
import { API_KEY_SCOPES, DEFAULT_SCOPES, scopesProblem } from "@/lib/api-scopes";
import { useAsync } from "@/lib/use-async";
import { AddressChip } from "../ui/address-chip";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input, Select } from "../ui/input";
import { Modal } from "../ui/modal";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { Tabs } from "../ui/tabs";
import { Tooltip } from "../ui/tooltip";

const WHEN = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  hourCycle: "h23",
  timeZone: "UTC",
});
const when = (iso: string) => `${WHEN.format(new Date(iso))} UTC`;

const EVENT_TYPES = [
  "invoice.created",
  "invoice.accepted",
  "invoice.partially_paid",
  "invoice.paid",
  "payment.late",
  "payout.failed",
  "invoice.closed",
] as const;

function SecretDialog({
  title,
  warning,
  secret,
  onClose,
}: {
  title: string;
  warning: string;
  secret: string | null;
  onClose: () => void;
}) {
  const t = copy.developers;
  return (
    <Modal open={secret !== null} onClose={onClose} title={title}>
      {secret ? (
        <div className="space-y-4">
          <p role="alert" className="text-[15px] font-medium">
            {warning}
          </p>
          <AddressChip value={secret} head={secret.length} tail={0} />
          <Button onClick={onClose}>{t.secretDone}</Button>
        </div>
      ) : null}
    </Modal>
  );
}

function Confirm({
  open,
  title,
  body,
  confirm,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  body: string;
  confirm: string;
  busy: boolean;
  error: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = copy.developers;
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        <p className="text-[15px]">{body}</p>
        {error ? (
          <p role="alert" className="text-danger-text text-[14px]">
            {t.actionFailed}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            {confirm}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ApiKeysPanel() {
  const t = copy.developers;
  const [keys, reload] = useAsync(() => dashClient.apiKeys.list(), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [rotate, setRotate] = useState<ApiKey | null>(null);
  const [revoke, setRevoke] = useState<ApiKey | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const idem = useRef(crypto.randomUUID());

  const rows: ApiKey[] = keys.state === "ready" ? keys.data.data : [];
  const active = rows.filter((k) => !k.revoked_at);

  const showSecret = (k: ApiKeyCreated) => {
    setSecret(k.secret);
    reload();
  };

  const columns: DataTableColumn<ApiKey>[] = [
    {
      id: "name",
      header: t.cols.name,
      sortable: true,
      value: (k) => k.name,
      cell: (k) => <span className="font-medium">{k.name}</span>,
    },
    {
      id: "prefix",
      header: t.cols.key,
      value: (k) => k.prefix,
      cell: (k) => (
        <code className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[12px]">
          {k.prefix}
          {"••••••••••••"}
        </code>
      ),
    },
    {
      id: "scopes",
      header: t.cols.scopes,
      hideBelow: "sm",
      value: (k) => k.scopes.join(" "),
      cell: (k) =>
        k.scopes.length === 0 ? (
          "—"
        ) : (
          <span className="flex flex-wrap gap-1">
            {k.scopes.map((scope) => (
              <span
                key={scope}
                className="inline-flex rounded-full bg-surface-2 px-2 py-0.5 text-[12px] font-medium text-muted"
              >
                {scope}
              </span>
            ))}
          </span>
        ),
    },
    {
      id: "used",
      header: t.cols.lastUsed,
      hideBelow: "md",
      value: (k) => (k.revoked_at ? t.revoked : (k.last_used_at ?? t.neverUsed)),
      cell: (k) =>
        k.revoked_at ? t.revoked : k.last_used_at ? t.lastUsed(when(k.last_used_at)) : t.neverUsed,
    },
  ];

  return (
    <>
      <Card
        title={t.keysTitle}
        action={
          <Button
            size="sm"
            icon={<Plus size={16} strokeWidth={1.5} aria-hidden />}
            onClick={() => {
              setName("");
              setScopes(DEFAULT_SCOPES);
              setShown(false);
              setFailed(false);
              setCreateOpen(true);
            }}
          >
            {t.createKey}
          </Button>
        }
        state={keys.state === "ready" ? (active.length === 0 ? "empty" : "ready") : keys.state}
        emptyTitle={t.keysEmptyTitle}
        emptyBody={t.keysEmptyBody}
        errorBody={t.sectionError}
        onRetry={reload}
      >
        <p className="caption mb-3">{t.keyCount(active.length)}</p>
        <DataTable
          data={rows}
          columns={columns}
          rowId={(k) => k.id}
          rowLabel={(k) => `${k.name} key`}
          caption={t.keysTitle}
          variant="minimal"
          density="compact"
          pageSize={8}
          rowActions={(k) =>
            k.revoked_at ? null : (
              <span className="flex justify-end gap-1">
                <Tooltip label={t.rotate(k.name)} side="left">
                  <button
                    type="button"
                    aria-label={t.rotate(k.name)}
                    onClick={() => {
                      setActionFailed(false);
                      setRotate(k);
                    }}
                    className="grid size-8 place-items-center rounded-xl text-muted transition-colors hover:bg-row hover:text-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                  >
                    <RotateCw aria-hidden size={16} />
                  </button>
                </Tooltip>
                <Tooltip label={t.revoke(k.name)} side="left">
                  <button
                    type="button"
                    aria-label={t.revoke(k.name)}
                    onClick={() => {
                      setActionFailed(false);
                      setRevoke(k);
                    }}
                    className="grid size-8 place-items-center rounded-xl text-muted transition-colors hover:bg-danger/10 hover:text-danger-text focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                  >
                    <Trash2 aria-hidden size={16} />
                  </button>
                </Tooltip>
              </span>
            )
          }
        />
      </Card>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={t.createKey}>
        <form
          noValidate
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setShown(true);
            if (name.trim() === "" || scopesProblem(scopes) !== null) return;
            setBusy(true);
            setFailed(false);
            try {
              const k = await dashClient.apiKeys.create(
                { name: name.trim(), scopes: API_KEY_SCOPES.filter((x) => scopes.includes(x)) },
                { idempotencyKey: idem.current },
              );
              idem.current = crypto.randomUUID();
              setCreateOpen(false);
              showSecret(k);
            } catch {
              setFailed(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input
            label={t.keyName}
            helper={t.keyNameHelp}
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={shown && name.trim() === "" ? t.badKeyName : undefined}
          />
          <fieldset className="space-y-2">
            <legend className="text-[14px] leading-5 font-medium">{t.scopes}</legend>
            <p className="caption">{t.scopesHelp}</p>
            {API_KEY_SCOPES.map((sc) => (
              <label key={sc} className="flex items-center gap-2 text-[14px]">
                <input
                  type="checkbox"
                  checked={scopes.includes(sc)}
                  onChange={(e) =>
                    setScopes((l) => (e.target.checked ? [...l, sc] : l.filter((x) => x !== sc)))
                  }
                  className="size-4 accent-[var(--accent)]"
                />
                <code className="font-mono text-[13px]">{sc}</code>
              </label>
            ))}
            {shown && scopesProblem(scopes) ? (
              <p className="text-danger-text text-[14px]">{scopesProblem(scopes)}</p>
            ) : null}
          </fieldset>
          {failed ? (
            <p role="alert" className="text-danger-text text-[14px]">
              {t.actionFailed}
            </p>
          ) : null}
          <Button type="submit" loading={busy}>
            {t.createKey}
          </Button>
        </form>
      </Modal>

      <SecretDialog
        title={t.secretTitle}
        warning={t.secretWarn}
        secret={secret}
        onClose={() => setSecret(null)}
      />

      <Confirm
        open={rotate !== null}
        title={t.rotateTitle}
        body={t.rotateBody}
        confirm={t.rotateConfirm}
        busy={actionBusy}
        error={actionFailed}
        onClose={() => setRotate(null)}
        onConfirm={async () => {
          if (!rotate) return;
          setActionBusy(true);
          try {
            const k = await dashClient.apiKeys.rotate(rotate.id);
            setRotate(null);
            showSecret(k);
          } catch {
            setActionFailed(true);
          } finally {
            setActionBusy(false);
          }
        }}
      />
      <Confirm
        open={revoke !== null}
        title={t.revokeTitle}
        body={t.revokeBody}
        confirm={t.revokeConfirm}
        busy={actionBusy}
        error={actionFailed}
        onClose={() => setRevoke(null)}
        onConfirm={async () => {
          if (!revoke) return;
          setActionBusy(true);
          try {
            await dashClient.apiKeys.delete(revoke.id);
            setRevoke(null);
            reload();
          } catch {
            setActionFailed(true);
          } finally {
            setActionBusy(false);
          }
        }}
      />
    </>
  );
}

function DeliveryLog({
  endpoint,
  onClose,
}: {
  endpoint: WebhookEndpoint | null;
  onClose: () => void;
}) {
  const t = copy.developers;
  const [log, retry] = useAsync(
    () =>
      endpoint
        ? dashClient.webhookEndpoints.deliveries(endpoint.id)
        : Promise.resolve({ data: [] }),
    [endpoint?.id],
  );
  return (
    <Modal open={endpoint !== null} onClose={onClose} title={t.deliveryTitle} variant="drawer">
      {log.state === "loading" ? <Card state="loading" /> : null}
      {log.state === "error" ? (
        <Card state="error" errorBody={t.sectionError} onRetry={retry} />
      ) : null}
      {log.state === "ready" ? (
        log.data.data.length === 0 ? (
          <p className="caption">{t.deliveryEmpty}</p>
        ) : (
          <ul className="divide-y divide-border">
            {log.data.data.map((d) => (
              <li key={d.id} className="space-y-1 py-3 text-[14px]">
                <p className="flex flex-wrap items-center justify-between gap-2">
                  <code className="font-mono text-[13px]">{d.type}</code>
                  <span className="tabular font-medium">{d.status_code}</span>
                </p>
                <p className="caption">
                  {t.attempt(d.attempt)}
                  {d.delivered_at ? ` · ${when(d.delivered_at)}` : ""}
                </p>
                {d.error ? <p className="text-danger-text">{d.error}</p> : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Modal>
  );
}

function HooksPanel() {
  const t = copy.developers;
  const [hooks, reload] = useAsync(() => dashClient.webhookEndpoints.list(), []);
  const [addOpen, setAddOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; text: string } | null>(null);
  const [log, setLog] = useState<WebhookEndpoint | null>(null);
  const [del, setDel] = useState<WebhookEndpoint | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delFailed, setDelFailed] = useState(false);
  const idem = useRef(crypto.randomUUID());

  const rows: WebhookEndpoint[] = hooks.state === "ready" ? hooks.data.data : [];
  const urlBad = !/^https:\/\/[^\s/]+/.test(url.trim());

  return (
    <>
      <Card
        title={t.hooksTitle}
        action={
          <Button
            size="sm"
            icon={<Plus size={16} strokeWidth={1.5} aria-hidden />}
            onClick={() => {
              setUrl("");
              setEvents([]);
              setShown(false);
              setFailed(false);
              setAddOpen(true);
            }}
          >
            {t.addEndpoint}
          </Button>
        }
        state={hooks.state === "ready" ? (rows.length === 0 ? "empty" : "ready") : hooks.state}
        emptyTitle={t.hooksEmptyTitle}
        emptyBody={t.hooksEmptyBody}
        errorBody={t.sectionError}
        onRetry={reload}
      >
        <ul className="divide-y divide-border">
          {rows.map((h) => (
            <li key={h.id} className="space-y-3 py-4">
              <div className="space-y-1">
                <p className="font-mono text-[13px] break-all">{h.url}</p>
                <p className="caption">{h.events.join(", ")}</p>
                <p className="caption">{t.created(when(h.created_at))}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={testing === h.id}
                  onClick={async () => {
                    setTesting(h.id);
                    try {
                      const r = await dashClient.webhookEndpoints.test(h.id);
                      setTestResult({
                        id: h.id,
                        text: r.delivered ? t.testOk(r.status_code) : t.testFail(r.status_code),
                      });
                    } catch {
                      setTestResult({ id: h.id, text: t.testError });
                    } finally {
                      setTesting(null);
                    }
                  }}
                >
                  {testing === h.id ? t.testing : t.testEvent}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setLog(h)}>
                  {t.deliveryLog}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setDelFailed(false);
                    setDel(h);
                  }}
                >
                  {t.deleteEndpoint}
                </Button>
              </div>
              {testResult?.id === h.id ? (
                <p role="status" className="text-[14px]">
                  {testResult.text}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title={t.addEndpoint}>
        <form
          noValidate
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setShown(true);
            if (urlBad || events.length === 0) return;
            setBusy(true);
            setFailed(false);
            try {
              const h = await dashClient.webhookEndpoints.create(
                { url: url.trim(), events: events as never },
                { idempotencyKey: idem.current },
              );
              idem.current = crypto.randomUUID();
              setAddOpen(false);
              setSecret(h.secret ?? null);
              reload();
            } catch {
              setFailed(true);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Input
            label={t.endpointUrl}
            helper={t.endpointHelp}
            value={url}
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
            error={shown && urlBad ? t.badUrl : undefined}
          />
          <fieldset className="space-y-2">
            <legend className="mb-1 text-[14px] leading-5 font-medium">{t.events}</legend>
            {EVENT_TYPES.map((ev) => (
              <label key={ev} className="flex items-center gap-2 text-[14px]">
                <input
                  type="checkbox"
                  checked={events.includes(ev)}
                  onChange={(e) =>
                    setEvents((l) => (e.target.checked ? [...l, ev] : l.filter((x) => x !== ev)))
                  }
                  className="size-4 accent-[var(--accent)]"
                />
                <code className="font-mono text-[13px]">{ev}</code>
              </label>
            ))}
            {shown && events.length === 0 ? (
              <p className="text-danger-text text-[14px]">{t.pickEvents}</p>
            ) : null}
          </fieldset>
          {failed ? (
            <p role="alert" className="text-danger-text text-[14px]">
              {t.actionFailed}
            </p>
          ) : null}
          <Button type="submit" loading={busy}>
            {t.addEndpoint}
          </Button>
        </form>
      </Modal>

      <SecretDialog
        title={t.hookSecretTitle}
        warning={t.hookSecretWarn}
        secret={secret}
        onClose={() => setSecret(null)}
      />
      <DeliveryLog endpoint={log} onClose={() => setLog(null)} />
      <Confirm
        open={del !== null}
        title={t.deleteTitle}
        body={t.deleteBody}
        confirm={t.deleteEndpoint}
        busy={delBusy}
        error={delFailed}
        onClose={() => setDel(null)}
        onConfirm={async () => {
          if (!del) return;
          setDelBusy(true);
          try {
            await dashClient.webhookEndpoints.delete(del.id);
            setDel(null);
            reload();
          } catch {
            setDelFailed(true);
          } finally {
            setDelBusy(false);
          }
        }}
      />
    </>
  );
}

function EventsPanel() {
  const t = copy.developers;
  const [type, setType] = useState("");
  const [events, reload] = useAsync(
    () => dashClient.events.list({ limit: 50, ...(type ? { type: type as never } : {}) }),
    [type],
  );
  const rows = events.state === "ready" ? events.data.data : [];
  const columns: DataTableColumn<(typeof rows)[number]>[] = [
    {
      id: "type",
      header: t.cols.type,
      sortable: true,
      value: (e) => e.type,
      cell: (e) => (
        <code className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[12px]">
          {e.type}
        </code>
      ),
    },
    {
      id: "id",
      header: t.cols.event,
      hideBelow: "sm",
      value: (e) => e.id,
      cell: (e) => <code className="font-mono text-[13px]">{e.id}</code>,
    },
    {
      id: "token",
      header: t.cols.token,
      hideBelow: "md",
      value: (e) => String((e.data as { token_id?: unknown } | undefined)?.token_id ?? ""),
    },
    {
      id: "time",
      header: t.cols.time,
      sortable: true,
      value: (e) => e.created,
      // A time before 2001 cannot be real: say so instead of showing 1 January 1970.
      cell: (e) =>
        e.created > 1_000_000_000 ? when(new Date(e.created * 1000).toISOString()) : "—",
    },
  ];
  return (
    <Card
      title={t.eventsTitle}
      state={events.state === "ready" ? (rows.length === 0 ? "empty" : "ready") : events.state}
      emptyTitle={t.eventsEmptyTitle}
      emptyBody={t.eventsEmptyBody}
      errorBody={t.sectionError}
      onRetry={reload}
    >
      <div className="mb-4 max-w-xs">
        <Select label={t.eventType} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">{t.allEvents}</option>
          {EVENT_TYPES.map((ev) => (
            <option key={ev} value={ev}>
              {ev}
            </option>
          ))}
        </Select>
      </div>
      <DataTable
        data={rows}
        columns={columns}
        rowId={(e) => e.id}
        rowLabel={(e) => `${e.type} ${e.id}`}
        caption={t.eventsTitle}
        variant="minimal"
        defaultSort={{ id: "time", dir: "desc" }}
        pageSize={10}
        searchable
        searchText={(e) => `${e.type} ${e.id} ${JSON.stringify(e.data ?? {})}`}
      />
    </Card>
  );
}

export function DevelopersScreen() {
  const t = copy.developers;
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-[32px] leading-10 font-bold">{t.title}</h1>
        <p className="text-[15px]">{t.intro}</p>
      </header>
      <Tabs
        label={t.tabs}
        items={[
          { id: "keys", label: t.keysTab, panel: <ApiKeysPanel /> },
          { id: "hooks", label: t.hooksTab, panel: <HooksPanel /> },
          { id: "events", label: t.eventsTab, panel: <EventsPanel /> },
        ]}
      />
    </div>
  );
}
