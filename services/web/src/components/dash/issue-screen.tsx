"use client";

import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Invoice } from "@openrail/api-client";
import { ApiError } from "@openrail/api-client";
import { copy } from "@/copy";
import { dashClient } from "@/lib/client";
import { formatUsd } from "@/lib/format";
import { formatNear, storageCreditLow } from "@/lib/near-amount";
import { DepositControl } from "../setup/deposit-control";
import {
  invoiceTotalCents,
  lineCents,
  normalizePrice,
  typedNumber,
  validateIssue,
  type IssueForm,
} from "@/lib/invoice-model";
import { useStorageCredit } from "@/lib/use-storage-credit";
import { useAsync } from "@/lib/use-async";
import { AddressChip } from "../ui/address-chip";
import { Button } from "../ui/button";
import { DateWheelField } from "../ui/date-wheel-field";
import { Card } from "../ui/card";
import { Skeleton } from "../ui/state";
import { Input, Select } from "../ui/input";
import { Modal } from "../ui/modal";
import { Tooltip } from "../ui/tooltip";
import { ErrorNote } from "@/components/ui/error-note";

const today = () => new Date().toISOString().slice(0, 10);
const blankLine = { description: "", quantity: "1", unit: "" };

function Preview({
  form,
  issuer,
  total,
}: {
  form: IssueForm;
  issuer: string;
  total: bigint | null;
}) {
  const t = copy.issue;
  return (
    <section aria-label={t.preview} className="surface-card space-y-4 p-6">
      <h2 className="text-[18px] leading-[26px] font-semibold">{t.preview}</h2>
      <div className="space-y-4 rounded-[10px] border border-border bg-bg p-5 text-[14px]">
        <div className="flex flex-wrap justify-between gap-2">
          <p className="font-semibold">{issuer || "—"}</p>
          <p className="font-mono text-[13px]">{form.invoiceNumber || "—"}</p>
        </div>
        <p>
          <span className="caption">{copy.fields.to}</span>
          <br />
          {form.debtorName || "—"}
        </p>
        <table className="w-full">
          <caption className="sr-only">{t.lines}</caption>
          <tbody>
            {form.lines.map((l, i) => {
              const c = lineCents(l.quantity, l.unit);
              return (
                <tr key={i} className="border-t border-border">
                  <td className="py-1.5">{l.description || "—"}</td>
                  <td className="tabular py-1.5 text-right">{c === null ? "—" : formatUsd(c)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="flex justify-between border-t border-border pt-2 font-semibold">
          <span>{t.total}</span>
          <span className="tabular">{total === null ? "—" : formatUsd(total)}</span>
        </p>
        <p className="caption">{t.previewPay}</p>
      </div>
    </section>
  );
}

function StorageCredit() {
  const t = copy.issue;
  const [credit, , watchDeposit] = useStorageCredit();
  const [sent, setSent] = useState(false);
  const balance = credit.state === "ready" ? BigInt(credit.data.balance) : null;
  const low = balance !== null && storageCreditLow(balance);

  return (
    <div id="storage-credit">
      <Card title={t.creditTitle} className="space-y-3">
        {credit.state === "loading" ? (
          <Skeleton className="h-6 w-32" />
        ) : credit.state === "error" ? (
          <p className="caption">{t.creditUnknown}</p>
        ) : (
          <>
            <p className="tabular text-[20px] leading-7 font-bold">{formatNear(balance!)} NEAR</p>
            <p className="caption">{t.creditHelp}</p>
            {credit.data.sponsor && credit.data.sponsor.remaining > 0 ? (
              <p role="status" className="text-[14px]">
                {t.sponsored(credit.data.sponsor.remaining)}
              </p>
            ) : null}
            {low ? (
              <p role="status" className="text-warning text-[14px]">
                {t.creditLow}
              </p>
            ) : null}
            {low || sent ? (
              <DepositControl
                contractId={credit.data.contract_id}
                suggestedYocto={credit.data.amount}
                onSent={() => {
                  setSent(true);
                  watchDeposit();
                }}
              />
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}

function DoneSheet({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const t = copy.issue;
  return (
    <div className="space-y-5">
      <p className="text-[15px]">{t.doneBody}</p>
      <div className="flex justify-center rounded-xl bg-white p-3">
        <QRCodeSVG
          value={invoice.pay_link}
          size={140}
          level="M"
          title={`${t.payLink}: ${invoice.pay_link}`}
        />
      </div>
      <dl className="space-y-3">
        <div>
          <dt className="caption">{t.payLink}</dt>
          <dd>
            <AddressChip value={invoice.pay_link} head={30} tail={8} />
          </dd>
        </div>
        <div>
          <dt className="caption">{t.ackLink}</dt>
          <dd>
            <AddressChip value={invoice.ack_url} head={30} tail={8} />
          </dd>
        </div>
        <div>
          <dt className="caption">{t.account}</dt>
          <dd>
            <AddressChip value={invoice.claim_account} head={12} tail={14} />
          </dd>
        </div>
        <div>
          <dt className="caption">{t.hash}</dt>
          <dd>
            <AddressChip value={invoice.terms_hash} head={10} tail={8} />
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap gap-3">
        <Link href={`/app/invoices/${encodeURIComponent(invoice.id)}`}>
          <Button variant="secondary" onClick={onClose}>
            {t.openInvoice}
          </Button>
        </Link>
      </div>
    </div>
  );
}

export function IssueScreen() {
  const t = copy.issue;
  const [biz] = useAsync(() => dashClient.business.get(), []);
  const [issuerEdit, setIssuerEdit] = useState<string | null>(null);
  const issuer = issuerEdit ?? (biz.state === "ready" ? biz.data.legal_name : "");

  const [form, setForm] = useState<IssueForm>({
    invoiceNumber: "",
    debtorName: "",
    debtorType: "near",
    debtorKey: "",
    dueDate: "",
    lines: [{ ...blankLine }],
  });
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<false | "credit" | "other">(false);
  const [created, setCreated] = useState<Invoice | null>(null);
  const idem = useRef(crypto.randomUUID());

  const errors = useMemo(() => validateIssue(form, today()), [form]);
  const total = invoiceTotalCents(form.lines);
  const set = <K extends keyof IssueForm>(k: K, v: IssueForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const setLine = (i: number, patch: Partial<IssueForm["lines"][number]>) =>
    setForm((f) => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const err = (k: string) => (shown ? errors[k] : undefined);
  const hasErrors = Object.keys(errors).length > 0 || issuer.trim() === "" || total === null;

  const submit = async () => {
    setShown(true);
    setFailed(false);
    if (hasErrors || total === null) return;
    setBusy(true);
    try {
      const inv = await dashClient.invoices.create(
        {
          invoice_number: form.invoiceNumber.trim(),
          issuer_legal_name: issuer.trim(),
          debtor_legal_name: form.debtorName.trim(),
          debtor_key: form.debtorKey.trim(),
          debtor_type: form.debtorType,
          amount_usd: formatUsd(total).slice(1).replaceAll(",", ""),
          due_date: form.dueDate,
          line_items: form.lines.map((l) => ({
            description: l.description.trim(),
            quantity: Number(l.quantity),
            unit_amount_usd: normalizePrice(l.unit),
          })),
        },
        { idempotencyKey: idem.current },
      );
      setCreated(inv);
    } catch (e) {
      // 409 means the same key was used for a different body: start a fresh attempt.
      if (e instanceof ApiError && e.status === 409) idem.current = crypto.randomUUID();
      // 402: no free invoices left and no storage credit. Say so, and bring the deposit into view.
      if (e instanceof ApiError && e.status === 402) {
        setFailed("credit");
        document
          .getElementById("storage-credit")
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        setFailed("other");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-[32px] leading-10 font-bold">{t.title}</h1>
        <p className="text-[15px]">{t.intro}</p>
      </header>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <form
          noValidate
          className="surface-card space-y-6 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input
            label={t.from}
            helper={t.fromHelp}
            value={issuer}
            onChange={(e) => setIssuerEdit(e.target.value)}
            loading={biz.state === "loading"}
            error={shown && issuer.trim() === "" ? t.fromHelp : undefined}
          />
          <Input
            label={t.client}
            value={form.debtorName}
            onChange={(e) => set("debtorName", e.target.value)}
            error={err("debtorName")}
          />
          <div className="grid gap-6 sm:grid-cols-2">
            <Select
              label={t.clientAccountType}
              value={form.debtorType}
              onValueChange={(v) => set("debtorType", v as IssueForm["debtorType"])}
            >
              <option value="near">{t.near}</option>
              <option value="evm">{t.evm}</option>
            </Select>
            <Input
              label={t.clientAccount}
              helper={form.debtorType === "near" ? t.clientAccountHelpNear : t.clientAccountHelpEvm}
              value={form.debtorKey}
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => set("debtorKey", e.target.value.trim())}
              error={err("debtorKey")}
            />
          </div>
          <div className="grid gap-6 sm:grid-cols-2">
            <Input
              label={t.number}
              className="font-mono"
              value={form.invoiceNumber}
              onChange={(e) => set("invoiceNumber", e.target.value)}
              error={err("invoiceNumber")}
            />
            <DateWheelField
              label={t.dueDate}
              value={form.dueDate}
              onChange={(iso) => set("dueDate", iso)}
              error={err("dueDate")}
            />
          </div>
          <Select label={t.currency} helper={t.currencyHelp} value="usd" disabled>
            <option value="usd">USD</option>
          </Select>

          <fieldset className="space-y-4">
            <legend className="mb-2 text-[14px] leading-5 font-medium">{t.lines}</legend>
            {form.lines.map((l, i) => (
              <div
                key={i}
                className="grid grid-cols-[88px_1fr_44px] items-start gap-2 sm:grid-cols-[1fr_72px_96px_36px]"
              >
                <div className="col-span-3 sm:col-span-1">
                  <Input
                    label={t.description}
                    value={l.description}
                    onChange={(e) => setLine(i, { description: e.target.value })}
                    error={err(`line.${i}.description`)}
                  />
                </div>
                <Input
                  label={t.quantity}
                  inputMode="decimal"
                  value={l.quantity}
                  onChange={(e) => setLine(i, { quantity: typedNumber(e.target.value, 2) })}
                />
                <Input
                  label={t.price}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={l.unit}
                  onChange={(e) => setLine(i, { unit: typedNumber(e.target.value, 2) })}
                  error={err(`line.${i}.amount`)}
                />
                <Tooltip label={t.removeLineShort} side="top">
                  <button
                    type="button"
                    aria-label={t.removeLine(i + 1)}
                    disabled={form.lines.length === 1}
                    onClick={() =>
                      setForm((f) => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))
                    }
                    className="mt-1 grid size-9 place-items-center rounded-[10px] text-muted hover:bg-surface-2 disabled:opacity-40"
                  >
                    <Trash2 size={18} strokeWidth={1.5} aria-hidden />
                  </button>
                </Tooltip>
              </div>
            ))}
            {err("lines") ? <p className="text-danger-text text-[14px]">{errors.lines}</p> : null}
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus size={16} strokeWidth={1.5} aria-hidden />}
              onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, { ...blankLine }] }))}
            >
              {t.addLine}
            </Button>
          </fieldset>

          <p className="flex items-baseline justify-between border-t border-border pt-4 text-[18px] font-semibold">
            <span>{t.total}</span>
            <span className="tabular" data-testid="issue-total">
              {total === null ? "—" : formatUsd(total)}
            </span>
          </p>
          <p className="caption">{t.cost}</p>
          <ErrorNote>
            {failed === "credit"
              ? t.createNeedsCredit
              : failed
                ? t.createFailed
                : shown && hasErrors
                  ? t.fixErrors
                  : null}
          </ErrorNote>
          <Button type="submit" loading={busy} className="w-full sm:w-auto">
            {busy ? t.creating : t.create}
          </Button>
        </form>

        <div className="space-y-6">
          <StorageCredit />
          <Preview form={form} issuer={issuer} total={total} />
        </div>
      </div>

      <Modal open={created !== null} onClose={() => setCreated(null)} title={t.doneTitle}>
        {created ? <DoneSheet invoice={created} onClose={() => setCreated(null)} /> : null}
      </Modal>
    </div>
  );
}
