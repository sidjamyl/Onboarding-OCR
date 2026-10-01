"use client";

import { RotateCcw } from "lucide-react";
import { consistencyCopy } from "@/lib/consistency-copy";
import { comparisonDocumentKinds, comparisonRetryTargets, comparisonValue } from "@/lib/consistency-guidance";
import { documentLabels } from "@/lib/i18n";
import { fieldLabel, journeyCopy, sideLabel } from "@/lib/journey-copy";
import type { ConsistencyCheck, ConsistencyReport, DocumentKind, DocumentSide, Locale, PublicSession } from "@/lib/types";

const identityFields = new Set(["nin", "dateOfBirth", "date_of_birth", "lastNameLatin", "firstNameLatin", "lastNameArabic", "firstNameArabic", "surname_latin", "given_name_latin", "surname_ar", "given_name_ar"]);

export function ConsistencyResult({ report, documents, locale, busy = false, onRetake }: {
  report?: ConsistencyReport;
  documents: PublicSession["documents"];
  locale: Locale;
  busy?: boolean;
  onRetake?: (kind: DocumentKind, side: DocumentSide) => void;
}) {
  const checks = report?.checks.filter((check) => identityFields.has(check.field) && (check.status === "failed" || check.status === "warning")) ?? [];
  if (!checks.length) return null;
  const text = consistencyCopy[locale];
  const groups = new Map<string, ConsistencyCheck[]>();
  const targets = new Map<string, { kind: DocumentKind; side: DocumentSide }>();
  for (const check of checks) {
    groups.set(check.field, [...(groups.get(check.field) ?? []), check]);
    for (const target of comparisonRetryTargets(check, documents)) targets.set(target.kind + "/" + target.side, target);
  }
  const exhausted = (kind: DocumentKind, side: DocumentSide) => (documents[kind]?.ocrAttempts ?? 0) >= 3 || (documents[kind]?.sideOcrAttempts?.[side] ?? 0) >= 3;
  const available = [...targets.values()].filter(({ kind, side }) => !exhausted(kind, side));
  const suggested = checks.flatMap((check) => check.suggestedRetry ? [check.suggestedRetry] : []).find((retry) => available.some(({ kind, side }) => kind === comparisonDocumentKinds[retry.document] && (!retry.side || side === retry.side)));
  const selected = available.find(({ kind, side }) => suggested && kind === comparisonDocumentKinds[suggested.document] && (!suggested.side || side === suggested.side)) ?? available[0];
  return (
    <section className="journey-consistency" aria-label={text.title} dir={locale === "ar" ? "rtl" : "ltr"}>
      <header role={report?.blocking ? "alert" : undefined}>
        <h2>{text.title}</h2>
        <p>{text.detail}</p>
      </header>
      <ul className="journey-comparisons">
        {[...groups].map(([field, comparisons]) => {
          const readings = [...new Map(comparisons.flatMap((check) => check.readings).map((reading) => [reading.document + "/" + (reading.side ?? "") + "/" + comparisonValue(reading.value), reading])).values()];
          return (
            <li key={field}>
              <h3>{fieldLabel(locale, field)}</h3>
              <dl className="journey-comparison-readings">
                {readings.map((reading, index) => {
                  const kind = comparisonDocumentKinds[reading.document];
                  return <div key={kind + "/" + (reading.side ?? index)}>
                    <dt>{documentLabels[locale][kind]}{reading.side ? " · " + sideLabel(locale, reading.side) : ""}</dt>
                    <dd><bdi>{comparisonValue(reading.value) ?? journeyCopy[locale].missingValue}</bdi></dd>
                  </div>;
                })}
              </dl>
            </li>
          );
        })}
      </ul>
      {onRetake && available.length > 0 && <form className="journey-comparison-actions" onSubmit={(event) => {
        event.preventDefault();
        const control = event.currentTarget.elements.namedItem("retake-target") as HTMLSelectElement;
        const target = targets.get(control.value);
        if (!busy && target && !exhausted(target.kind, target.side)) onRetake(target.kind, target.side);
      }}>
        <label className="journey-retry-choice">
          <span>{text.chooseSide}</span>
          <select name="retake-target" disabled={busy} defaultValue={selected ? selected.kind + "/" + selected.side : undefined}>
            {[...targets.values()].map(({ kind, side }) => <option key={kind + "/" + side} value={kind + "/" + side} disabled={exhausted(kind, side)}>
              {documentLabels[locale][kind]} · {sideLabel(locale, side)}
            </option>)}
          </select>
        </label>
        <button type="submit" className="journey-primary" disabled={busy}>
          <RotateCcw size={16} aria-hidden="true" /> {journeyCopy[locale].retake}
        </button>
      </form>}
      {onRetake && available.length === 0 && <p className="journey-comparison-limit">{text.attemptsReached}</p>}
    </section>
  );
}
