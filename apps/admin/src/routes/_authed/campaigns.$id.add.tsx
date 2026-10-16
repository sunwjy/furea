import {
  CAMPAIGN_LINK_LIMIT,
  campaignUtmKey,
  composeUtm,
  type BulkCreateCampaignLinksRequest,
  type Campaign,
  type ErrorDetail,
  type Link as LinkResource,
} from "@furea/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ClipboardPaste, Plus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
type Row = Record<Column, string> & { key: number };

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

let nextKey = 0;
const emptyRow = (): Row => ({ key: nextKey++, source: "", medium: "", content: "", term: "", slug: "", title: "" });
const isFilled = (row: Row) => COLUMNS.some((column) => row[column].trim() !== "");

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

function composeFor(campaign: Campaign, row: Row): string {
  return composeUtm(campaign.baseUrl, {
    utm_id: campaign.utmId ?? "",
    utm_source: row.source,
    utm_medium: row.medium,
    utm_campaign: campaign.utmCampaign,
    utm_term: row.term,
    utm_content: row.content,
  });
}

function RowEditor({ campaign, members }: { campaign: Campaign; members: LinkResource[] }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [rows, setRows] = useState<Row[]>(() => [emptyRow(), emptyRow(), emptyRow()]);
  const [paste, setPaste] = useState<string | null>(null);
  // The rows as sent and the API's answer for them: per-row errors map back through the sent rows' keys.
  const [failure, setFailure] = useState<{ sent: number[]; error: unknown } | null>(null);
  const [sending, setSending] = useState(false);

  const filled = rows.filter(isFilled);
  const room = CAMPAIGN_LINK_LIMIT - campaign.linkCount;
  const memberByKey = new Map(
    members.flatMap((link) => (link.utm === null ? [] : [[campaignUtmKey(link.utm), link.slug] as const])),
  );

  function setCell(key: number, column: Column, value: string) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, [column]: value } : row)));
  }

  function importPaste() {
    const pasted = parsePaste(paste ?? "");
    setRows((current) => [...current.filter(isFilled), ...pasted, emptyRow()]);
    setPaste(null);
  }

  async function send(screening?: "skip") {
    const body: BulkCreateCampaignLinksRequest = {
      items: filled.map((row) => ({
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
      setFailure({ sent: filled.map((row) => row.key), error });
      if (!(error instanceof ApiError)) toast.error("Could not create the links. Try again.");
    } finally {
      setSending(false);
    }
  }

  const error = failure?.error;
  const host = flaggedHost(error, "baseUrl");
  const details = error instanceof ApiError && error.code === "validation_failed" ? error.details : [];
  /** The API's details for one row, by the index it had in the request. */
  function rowDetails(row: Row): ErrorDetail[] {
    const index = failure?.sent.indexOf(row.key) ?? -1;
    if (index === -1) return [];
    return details.filter((d) => d.field === `items[${index}]` || d.field.startsWith(`items[${index}].`));
  }
  const failedRows = new Set(details.map((d) => /^items\[(\d+)\]/.exec(d.field)?.[1])).size;

  return (
    <div className="flex flex-col gap-4">
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
            {rows.map((row, i) => {
              const problems = rowDetails(row);
              const ready = row.source.trim() !== "" && row.medium.trim() !== "";
              const existing = ready ? memberByKey.get(campaignUtmKey(row)) : undefined;
              return (
                <RowLines
                  key={row.key}
                  row={row}
                  number={i + 1}
                  problems={problems}
                  warning={
                    existing !== undefined && problems.length === 0
                      ? `Already in the campaign as /${existing} (compared ignoring case).`
                      : null
                  }
                  destination={ready ? composeFor(campaign, row) : null}
                  onChange={(column, value) => setCell(row.key, column, value)}
                  onRemove={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setRows((current) => [...current, emptyRow()])}>
          <Plus data-icon="inline-start" />
          Row
        </Button>
        <Button variant="outline" size="sm" onClick={() => setPaste("")}>
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
            <Button size="sm" onClick={importPaste}>
              Add rows
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPaste(null)}>
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
          action={`Create ${filled.length === 1 ? "1 link" : `${filled.length} links`} anyway`}
          pending={sending}
          onOverride={() => void send("skip")}
        />
      ) : null}
      <div className="flex items-center gap-3">
        <Button disabled={filled.length === 0 || sending} onClick={() => void send()}>
          {sending ? "Creating…" : `Create ${filled.length === 1 ? "1 link" : `${filled.length} links`}`}
        </Button>
        {filled.length > room ? (
          <span className="text-sm text-destructive">
            Only {room} more {room === 1 ? "link fits" : "links fit"} in this campaign.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function RowLines({
  row,
  number,
  problems,
  warning,
  destination,
  onChange,
  onRemove,
}: {
  row: Row;
  number: number;
  problems: ErrorDetail[];
  warning: string | null;
  destination: string | null;
  onChange: (column: Column, value: string) => void;
  onRemove: () => void;
}) {
  const invalid = (column: Column) =>
    problems.some((d) => d.field.endsWith(`.${column}`) || (d.field.endsWith(".utm") && column !== "slug" && column !== "title"));

  return (
    <>
      <tr className={problems.length > 0 ? "bg-destructive/5" : undefined}>
        <td className="px-2 py-1 text-muted-foreground">{number}</td>
        {COLUMNS.map((column) => (
          <td key={column} className="px-1 py-1">
            <Input
              aria-label={`Row ${number} ${LABELS[column]}`}
              name={INPUT_NAMES[column]}
              autoComplete={column in INPUT_NAMES ? "on" : "off"}
              spellCheck={false}
              placeholder={column === "slug" ? "generated" : undefined}
              aria-invalid={invalid(column) ? true : undefined}
              className="min-w-24"
              value={row[column]}
              onChange={(event) => onChange(column, event.target.value)}
            />
          </td>
        ))}
        <td className="px-1 py-1">
          <Button variant="ghost" size="icon-sm" aria-label={`Remove row ${number}`} onClick={onRemove}>
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
                {problems.map((d) => (
                  <li key={`${d.field}:${d.code}`}>{d.message}</li>
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
