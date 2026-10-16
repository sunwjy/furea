import {
  CAMPAIGN_LINK_LIMIT,
  campaignUtmKey,
  composeCampaignLink,
  CustomSlug,
  RequiredUtmValue,
  Title,
  UtmValue,
  type BulkCreateCampaignLinksRequest,
  type Campaign,
  type Link as LinkResource,
} from "@furea/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ClipboardPaste, Plus, X } from "lucide-react";
import { useState } from "react";
import { type Control, Controller, useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScreeningRefusal } from "@/components/screening-refusal";
import { ApiError, flaggedHost } from "@/lib/api";
import { CAMPAIGNS_KEY, campaignLinksQuery, campaignQuery, createCampaignLinks } from "@/lib/campaigns";
import { LINKS_KEY } from "@/lib/links";

export const Route = createFileRoute("/_authed/campaigns/$id/add")({
  component: AddLinksPage,
});

function AddLinksPage() {
  const { id } = Route.useParams();
  const campaign = useQuery(campaignQuery(id));
  const members = useQuery(campaignLinksQuery(id));

  return (
    <div className="flex flex-col gap-6">
      <Link
        to="/campaigns/$id"
        params={{ id }}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {campaign.data?.name ?? "Campaign"}
      </Link>
      {campaign.isPending || members.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : campaign.isError || members.isError ? (
        <p className="text-sm text-destructive">
          {campaign.error instanceof ApiError && campaign.error.status === 404
            ? "There is no such campaign."
            : "Could not load the campaign."}
        </p>
      ) : (
        <RowEditor campaign={campaign.data} members={members.data.items} />
      )}
    </div>
  );
}

/** The columns of a row, in the order a spreadsheet paste fills them. */
const COLUMNS = ["source", "medium", "content", "term", "slug", "title"] as const;
type Column = (typeof COLUMNS)[number];
type Row = Record<Column, string>;

const LABELS: Record<Column, string> = {
  source: "Source",
  medium: "Medium",
  content: "Content",
  term: "Term",
  slug: "Custom slug",
  title: "Title",
};

/** The parameter names, so the browser's own autocomplete suggests earlier values (ADR 0014). */
const INPUT_NAMES: Partial<Record<Column, string>> = {
  source: "utm_source",
  medium: "utm_medium",
  content: "utm_content",
  term: "utm_term",
};

const emptyRow = (): Row => ({ source: "", medium: "", content: "", term: "", slug: "", title: "" });
const isFilled = (row: Row) => COLUMNS.some((column) => row[column].trim() !== "");

/** The bulk-create item's own field schemas, checked on the rows that are filled; a blank row is not sent. */
const ROW_CHECKS: [Column, z.ZodType][] = [
  ["source", RequiredUtmValue],
  ["medium", RequiredUtmValue],
  ["content", UtmValue],
  ["term", UtmValue],
  ["slug", z.string().trim().pipe(z.literal("").or(CustomSlug))],
  ["title", Title],
];
const RowForm = z
  .object({ source: z.string(), medium: z.string(), content: z.string(), term: z.string(), slug: z.string(), title: z.string() })
  .superRefine((row, ctx) => {
    if (!isFilled(row)) return;
    for (const [column, schema] of ROW_CHECKS) {
      const result = schema.safeParse(row[column]);
      if (!result.success) ctx.addIssue({ code: "custom", path: [column], message: result.error.issues[0]?.message ?? "Invalid." });
    }
  });
const RowsForm = z.object({ rows: z.array(RowForm) });
type RowsValues = z.infer<typeof RowsForm>;

/** Tab-separated cells as a spreadsheet copies them; a header row starting with "source" is skipped. */
function parsePaste(text: string): Row[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter((cells) => cells.some((cell) => cell.trim() !== ""))
    .filter((cells) => cells[0]?.trim().toLowerCase() !== "source")
    .map((cells) => {
      const row = emptyRow();
      COLUMNS.forEach((column, i) => (row[column] = cells[i]?.trim() ?? ""));
      return row;
    });
}

function RowEditor({ campaign, members }: { campaign: Campaign; members: LinkResource[] }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const form = useForm<RowsValues>({
    resolver: zodResolver(RowsForm),
    defaultValues: { rows: [emptyRow(), emptyRow(), emptyRow()] },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "rows" });
  const rows = form.watch("rows");
  const rowErrors = form.formState.errors.rows;
  const [paste, setPaste] = useState<string | null>(null);
  // The rows as sent (by field id) and the API's answer for them: per-row errors map back through the ids.
  const [failure, setFailure] = useState<{ sent: string[]; error: unknown } | null>(null);
  const [sending, setSending] = useState(false);

  const filled = rows.filter(isFilled);
  const room = CAMPAIGN_LINK_LIMIT - campaign.linkCount;
  const memberByKey = new Map(
    members.flatMap((link) => (link.utm === null ? [] : [[campaignUtmKey(link.utm), link.slug] as const])),
  );

  function importPaste() {
    const current = form.getValues("rows");
    remove(current.flatMap((row, i) => (isFilled(row) ? [] : [i])));
    append([...parsePaste(paste ?? ""), emptyRow()]);
    setPaste(null);
  }

  async function send(screening?: "skip") {
    const current = form.getValues("rows");
    const sent = fields.filter((_, i) => current[i] !== undefined && isFilled(current[i])).map((field) => field.id);
    const body: BulkCreateCampaignLinksRequest = {
      items: current.filter(isFilled).map((row) => ({
        utm: { source: row.source, medium: row.medium, content: row.content, term: row.term },
        ...(row.slug.trim() === "" ? {} : { slug: row.slug.trim() }),
        ...(row.title.trim() === "" ? {} : { title: row.title }),
      })),
      ...(screening ? { screening } : {}),
    };
    setSending(true);
    setFailure(null);
    try {
      const { items } = await createCampaignLinks(campaign.id, body);
      await queryClient.invalidateQueries({ queryKey: CAMPAIGNS_KEY });
      await queryClient.invalidateQueries({ queryKey: LINKS_KEY });
      toast.success(`Created ${items.length === 1 ? "1 link" : `${items.length} links`} in ${campaign.name}.`);
      await navigate({ to: "/campaigns/$id", params: { id: campaign.id } });
    } catch (error) {
      setFailure({ sent, error });
      if (!(error instanceof ApiError)) toast.error("Could not create the links. Try again.");
    } finally {
      setSending(false);
    }
  }

  const onSubmit = form.handleSubmit(() => send());

  const error = failure?.error;
  const host = flaggedHost(error, "baseUrl");
  const details = error instanceof ApiError && error.code === "validation_failed" ? error.details : [];
  /** The form's own errors for one row, then the API's, by the index the row had in the request. */
  function rowProblems(id: string, index: number): Problem[] {
    const own = COLUMNS.flatMap((column) => {
      const message = rowErrors?.[index]?.[column]?.message;
      return message === undefined ? [] : [{ key: `form:${column}`, columns: [column], message }];
    });
    const sentIndex = failure?.sent.indexOf(id) ?? -1;
    if (sentIndex === -1) return own;
    const prefix = `items[${sentIndex}]`;
    const fromApi = details
      .filter((d) => d.field === prefix || d.field.startsWith(`${prefix}.`))
      .map((d) => ({ key: `api:${d.field}:${d.code}`, columns: columnsOf(d.field.slice(prefix.length + 1)), message: d.message }));
    return [...own, ...fromApi];
  }
  const failedRows = new Set(details.map((d) => /^items\[(\d+)\]/.exec(d.field)?.[1])).size;
  const count = filled.length === 1 ? "1 link" : `${filled.length} links`;

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-semibold">Add links to {campaign.name}</h1>
        <p className="text-sm text-muted-foreground">
          Each row becomes one short link to <code className="break-all">{campaign.baseUrl}</code> with{" "}
          <code>utm_campaign={campaign.utmCampaign}</code>
          {campaign.utmId === null ? null : (
            <>
              {" "}
              and <code>utm_id={campaign.utmId}</code>
            </>
          )}
          . Source and medium are required. All rows are created together, or none. {campaign.linkCount} of{" "}
          {CAMPAIGN_LINK_LIMIT} used.
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table aria-label="New links" className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="w-8 px-2 py-2 font-medium">#</th>
              {COLUMNS.map((column) => (
                <th key={column} className="px-2 py-2 font-medium">
                  {LABELS[column]}
                  {column === "source" || column === "medium" ? " *" : null}
                </th>
              ))}
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {fields.map((field, i) => {
              const row = rows[i] ?? emptyRow();
              const problems = rowProblems(field.id, i);
              const ready = row.source.trim() !== "" && row.medium.trim() !== "";
              const existing = ready ? memberByKey.get(campaignUtmKey(row)) : undefined;
              return (
                <RowLines
                  key={field.id}
                  control={form.control}
                  index={i}
                  problems={problems}
                  warning={
                    existing !== undefined && problems.length === 0
                      ? `Already in the campaign as /${existing} (compared ignoring case).`
                      : null
                  }
                  destination={ready ? composeCampaignLink(campaign, row) : null}
                  onRemove={() => remove(i)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => append(emptyRow())}>
          <Plus data-icon="inline-start" />
          Row
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setPaste("")}>
          <ClipboardPaste data-icon="inline-start" />
          Paste from spreadsheet…
        </Button>
      </div>
      {paste !== null ? (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <label htmlFor="paste" className="text-sm font-medium">
            Paste rows: source, medium, content, term, custom slug and title, separated by tabs (copied spreadsheet
            cells)
          </label>
          <textarea
            id="paste"
            rows={6}
            className="w-full rounded-md border bg-transparent px-2 py-1 font-mono text-xs"
            value={paste}
            placeholder={"newsletter\temail\ninstagram\tsocial\tstory\ninstagram\tsocial\tpost"}
            onChange={(event) => setPaste(event.target.value)}
          />
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={importPaste}>
              Add rows
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setPaste(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {failedRows > 0 ? (
        <p role="alert" className="text-sm text-destructive">
          Nothing was created: fix the {failedRows === 1 ? "marked row" : `${failedRows} marked rows`}.
        </p>
      ) : error instanceof ApiError && host === null ? (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      ) : null}
      {host !== null ? (
        <ScreeningRefusal
          host={host}
          action={`Create ${count} anyway`}
          pending={sending}
          onOverride={() => void send("skip")}
        />
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={filled.length === 0 || sending}>
          {sending ? "Creating…" : `Create ${count}`}
        </Button>
        {filled.length > room ? (
          <span className="text-sm text-destructive">
            Only {room} more {room === 1 ? "link fits" : "links fit"} in this campaign.
          </span>
        ) : null}
      </div>
    </form>
  );
}

/** One message under a row, and the cells it marks. */
interface Problem {
  key: string;
  columns: Column[];
  message: string;
}

/** The cells an API detail's field (after `items[i].`) points at; `utm` is every UTM cell. */
function columnsOf(field: string): Column[] {
  if (field === "utm" || field.startsWith("utm.")) return ["source", "medium", "content", "term"];
  return (COLUMNS as readonly string[]).includes(field) ? [field as Column] : [];
}

function RowLines({
  control,
  index,
  problems,
  warning,
  destination,
  onRemove,
}: {
  control: Control<RowsValues>;
  index: number;
  problems: Problem[];
  warning: string | null;
  destination: string | null;
  onRemove: () => void;
}) {
  const number = index + 1;
  const invalid = (column: Column) => problems.some((p) => p.columns.includes(column));

  return (
    <>
      <tr className={problems.length > 0 ? "bg-destructive/5" : undefined}>
        <td className="px-2 py-1 text-muted-foreground">{number}</td>
        {COLUMNS.map((column) => (
          <td key={column} className="px-1 py-1">
            <Controller
              control={control}
              name={`rows.${index}.${column}`}
              render={({ field }) => (
                <Input
                  aria-label={`Row ${number} ${LABELS[column]}`}
                  // Not the form path: the parameter name, for the browser's autocomplete.
                  name={INPUT_NAMES[column]}
                  autoComplete={column in INPUT_NAMES ? "on" : "off"}
                  spellCheck={false}
                  placeholder={column === "slug" ? "generated" : undefined}
                  aria-invalid={invalid(column) ? true : undefined}
                  className="min-w-24"
                  ref={field.ref}
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            />
          </td>
        ))}
        <td className="px-1 py-1">
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove row ${number}`} onClick={onRemove}>
            <X />
          </Button>
        </td>
      </tr>
      {problems.length > 0 || warning !== null || destination !== null ? (
        <tr>
          <td />
          <td colSpan={COLUMNS.length + 1} className="px-2 pb-2 text-xs">
            {problems.length > 0 ? (
              <ul className="flex flex-col gap-0.5 text-destructive">
                {problems.map((p) => (
                  <li key={p.key}>{p.message}</li>
                ))}
              </ul>
            ) : warning !== null ? (
              <p className="text-amber-700">{warning}</p>
            ) : null}
            {destination !== null ? (
              <p className="truncate text-muted-foreground" title={destination}>
                → {destination}
              </p>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}
