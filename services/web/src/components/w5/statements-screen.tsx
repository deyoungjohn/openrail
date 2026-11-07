"use client";

import { Download } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { copy } from "@/copy";
import { dashClient } from "@/lib/client";
import { csvToTable, sha256OfBase64, statementFilename } from "@/lib/w5";
import { AddressChip } from "../ui/address-chip";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { DateRangeField } from "../ui/date-range-field";
import { Select } from "../ui/input";
import { EmptyState } from "../ui/state";
import { Table, type Column } from "../ui/table";

type Statement = Awaited<ReturnType<typeof dashClient.statements.get>>;

const PREVIEW_ROWS = 20;
const monthStart = () => new Date().toISOString().slice(0, 8) + "01";
const today = () => new Date().toISOString().slice(0, 10);

function Result({ s, from, to }: { s: Statement; from: string; to: string }) {
  const t = copy.statements;
  const [match, setMatch] = useState<boolean | null>(null);
  const bytes = useMemo(() => Uint8Array.from(atob(s.content_base64), (c) => c.charCodeAt(0)), [s]);
  const url = useMemo(
    () => URL.createObjectURL(new Blob([bytes], { type: s.content_type })),
    [bytes, s],
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  useEffect(() => {
    let off = false;
    void sha256OfBase64(s.content_base64).then(
      (h) => !off && setMatch(h === s.sha256.toLowerCase()),
    );
    return () => {
      off = true;
    };
  }, [s]);

  const name = statementFilename(s, from, to);
  const table = s.format === "csv" ? csvToTable(new TextDecoder().decode(bytes)) : null;
  const columns: Column<string[]>[] = (table?.header ?? []).map((h, i) => ({
    key: String(i),
    header: h,
    render: (row) => row[i] ?? "",
  }));

  return (
    <div className="space-y-4">
      <Card title={t.fingerprint}>
        <AddressChip value={s.sha256} head={66} tail={0} />
        {match === true ? (
          <p role="status" className="mt-3 text-[14px] font-medium">
            {t.matches}
          </p>
        ) : null}
        {match === false ? (
          <p role="alert" className="text-danger-text mt-3 text-[14px]">
            {t.mismatch}
          </p>
        ) : null}
        <p className="mt-4">
          <a
            href={url}
            download={name}
            className="inline-flex h-11 items-center gap-2 rounded-[10px] border border-border bg-surface px-4 text-[14px] font-medium hover:bg-surface-2"
          >
            <Download size={18} strokeWidth={1.5} aria-hidden />
            {t.download(name)}
          </a>
        </p>
      </Card>

      {table ? (
        table.rows.length === 0 ? (
          <div className="surface-card">
            <EmptyState title={t.emptyTitle} body={t.emptyBody} />
          </div>
        ) : (
          <>
            <Table
              caption={t.previewCaption}
              columns={columns}
              rows={table.rows.slice(0, PREVIEW_ROWS)}
              rowKey={(r) => r.join("|")}
            />
            {table.rows.length > PREVIEW_ROWS ? (
              <p className="caption">{t.previewMore(PREVIEW_ROWS, table.rows.length)}</p>
            ) : null}
          </>
        )
      ) : (
        <p className="caption">{t.noPreview}</p>
      )}
    </div>
  );
}

export function StatementsScreen() {
  const t = copy.statements;
  // `?token_id=c-1` scopes the statement to one invoice (SQ-13).
  const [tokenId, setTokenId] = useState<string | null>(useSearchParams().get("token_id"));
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [format, setFormat] = useState<"csv" | "pdf">("csv");
  const [problem, setProblem] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const [result, setResult] = useState<Statement | null>(null);

  const submit = async () => {
    if (!from || !to) return setProblem(t.missing);
    if (from > to) return setProblem(t.backwards);
    setProblem(null);
    setState("loading");
    setResult(null);
    try {
      setResult(
        await dashClient.statements.get({
          from,
          to,
          format,
          ...(tokenId ? { token_id: tokenId } : {}),
        }),
      );
      setState("idle");
    } catch {
      setState("failed");
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-[32px] leading-10 font-bold">{t.title}</h1>
        <p className="text-[15px]">{t.intro}</p>
      </header>

      <form
        noValidate
        className="surface-card space-y-6 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid items-end gap-6 sm:grid-cols-2">
          <div className="space-y-1.5">
            <p className="text-[14px] leading-5 font-medium">{t.period}</p>
            <DateRangeField
              label={t.period}
              value={{ from, to }}
              placeholder={t.missing}
              max={today()}
              onChange={(range) => {
                if (range === null) return;
                setFrom(range.from);
                setTo(range.to ?? range.from);
              }}
            />
          </div>
          <Select
            label={t.format}
            value={format}
            onValueChange={(v) => setFormat(v as "csv" | "pdf")}
          >
            <option value="csv">{t.csv}</option>
            <option value="pdf">{t.pdf}</option>
          </Select>
        </div>
        {tokenId ? (
          <p className="flex flex-wrap items-center gap-3 text-[14px]">
            <span className="font-medium">{t.scopeOne(tokenId)}</span>
            <Button variant="secondary" size="sm" onClick={() => setTokenId(null)}>
              {t.scopeAll}
            </Button>
          </p>
        ) : null}
        {problem ? (
          <p role="alert" className="text-danger-text text-[14px]">
            {problem}
          </p>
        ) : null}
        <Button type="submit" loading={state === "loading"}>
          {state === "loading" ? t.getting : t.get}
        </Button>
      </form>

      {state === "failed" ? (
        <p role="alert" className="text-danger-text text-[14px]">
          {t.failed}
        </p>
      ) : null}
      {result ? <Result s={result} from={from} to={to} /> : null}
    </div>
  );
}
