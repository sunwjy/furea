import { composeUtm, hasUtmKey, missingUtmCore, parseUtm, type UtmKey, type UtmWarning } from "@furea/shared";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import type { FieldValues, Path, PathValue, UseFormReturn } from "react-hook-form";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const FIELDS: { key: UtmKey; label: string; placeholder: string }[] = [
  { key: "utm_source", label: "Source", placeholder: "newsletter" },
  { key: "utm_medium", label: "Medium", placeholder: "email" },
  { key: "utm_campaign", label: "Campaign", placeholder: "spring-sale" },
  { key: "utm_term", label: "Term", placeholder: "running shoes" },
  { key: "utm_content", label: "Content", placeholder: "header-link" },
  { key: "utm_id", label: "Campaign ID", placeholder: "abc.123" },
];

const LABELS = Object.fromEntries(FIELDS.map((f) => [f.key, f.label.toLowerCase()])) as Record<UtmKey, string>;

function warningText(warning: UtmWarning): string {
  switch (warning.code) {
    case "case_variant_key":
      return `${warning.key} is not a UTM parameter to analytics tools (they read lowercase keys only); it is kept as ordinary query.`;
    case "duplicate_key":
      return `${warning.key} appears more than once. The first value is shown; editing a field keeps only one.`;
    case "malformed_percent":
      return `${warning.key} has a malformed percent sequence and is shown as entered.`;
  }
}

/**
 * The UTM builder of the plain-link form (ADR 0014): a collapsed section, opened when the destination already has a
 * lowercase `utm_*` key. Changing the destination re-parses it into the fields; editing a field re-composes the
 * destination through `onCompose`. Nothing is composed until a field is touched, so a pasted destination is saved
 * byte for byte.
 */
export function UtmBuilder({ destination, onCompose }: { destination: string; onCompose: (destination: string) => void }) {
  const id = useId();
  const [open, setOpen] = useState(() => hasUtmKey(destination));
  const [values, setValues] = useState(() => parseUtm(destination).values);
  // The destination last seen, and the one this builder last wrote: only a change from elsewhere is re-parsed, so a
  // value being typed (a trailing space, say) is not trimmed away under the cursor.
  const [seen, setSeen] = useState(destination);
  const [written, setWritten] = useState<string | null>(null);
  if (destination !== seen) {
    setSeen(destination);
    if (destination !== written) {
      setValues(parseUtm(destination).values);
      if (hasUtmKey(destination)) setOpen(true);
    }
  }

  function edit(key: UtmKey, value: string) {
    const next = { ...values, [key]: value };
    setValues(next);
    const composed = composeUtm(destination, next);
    setWritten(composed);
    onCompose(composed);
  }

  const { warnings } = parseUtm(destination);
  const missing = missingUtmCore(values);

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 self-start text-sm font-medium"
      >
        <ChevronRight className={`size-4 transition-transform ${open ? "rotate-90" : ""}`} />
        UTM parameters
      </button>
      <div id={id} hidden={!open} className="flex flex-col gap-4 border-l pl-4">
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          {FIELDS.map(({ key, label, placeholder }) => (
            <Field key={key}>
              <FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
              {/* A stable `name` (the parameter name) so the browser's own autocomplete suggests earlier values. */}
              <Input
                id={`${id}-${key}`}
                name={key}
                autoComplete="on"
                spellCheck={false}
                placeholder={placeholder}
                value={values[key]}
                onChange={(event) => edit(key, event.target.value)}
              />
            </Field>
          ))}
        </FieldGroup>
        {(warnings.length > 0 || missing.length > 0) && (
          <ul aria-label="UTM warnings" className="flex flex-col gap-1 text-sm text-amber-700 dark:text-amber-400">
            {missing.length > 0 && (
              <li className="flex gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                Most analytics tools need source, medium and campaign; {missing.map((k) => LABELS[k]).join(", ")}{" "}
                {missing.length === 1 ? "is" : "are"} empty.
              </li>
            )}
            {warnings.map((warning) => (
              <li key={`${warning.code}:${warning.key}`} className="flex gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                {warningText(warning)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * The builder's `onCompose` for a react-hook-form destination field: the output replaces the field's value, which is
 * validated as typed once the form was submitted.
 */
export function composeInto<T extends FieldValues, C, V extends FieldValues>(form: UseFormReturn<T, C, V>, name: Path<T>) {
  return (destination: string) =>
    form.setValue(name, destination as PathValue<T, Path<T>>, {
      shouldDirty: true,
      shouldValidate: form.formState.isSubmitted,
    });
}
