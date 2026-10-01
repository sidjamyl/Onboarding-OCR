"use client";

import { ConsistencyResult } from "./consistency-result";
import { Check, LoaderCircle, LockKeyhole, RotateCcw, TriangleAlert } from "lucide-react";
import { fieldLabel, journeyCopy, sideLabel } from "@/lib/journey-copy";
import { documentLabels } from "@/lib/i18n";
import { sideForMissingFields } from "@/lib/retake-guidance";
import { visibleDocumentFields } from "@/lib/document-field-order";
import type { DocumentKind, DocumentSide, Locale, ProcessingStage, PublicSession } from "@/lib/types";

type SessionDocument = NonNullable<PublicSession["documents"][DocumentKind]>;

export function DocumentResult({
  document,
  locale,
  busy = false,
  pendingSide,
  pendingStage,
  onRetake,
  onConfirm,
}: {
  document: SessionDocument;
  locale: Locale;
  busy?: boolean;
  pendingSide?: DocumentSide;
  pendingStage?: ProcessingStage;
  onRetake?: (side: DocumentSide) => void;
  onConfirm?: () => void;
}) {
  const text = journeyCopy[locale];
  const hasSideFields = document.requiredSides.some(
    (side) => Object.keys(document.sideFields?.[side] ?? {}).length > 0,
  );
  const groups =
    hasSideFields || pendingSide
      ? document.requiredSides.map((side) => ({ side, fields: document.sideFields?.[side] ?? {} }))
      : [{ side: "single" as const, fields: document.fields ?? {} }];
  const visibleFields = (fields: Record<string, string | null>) => visibleDocumentFields(document.kind, fields);
  const missing = document.unreadableFields;
  const cannotRetake = (side: DocumentSide) => busy || (document.sideOcrAttempts?.[side] ?? document.ocrAttempts) >= 3;
  const suggestedSide = sideForMissingFields(document);

  return (
    <article className="journey-result">
      <header className="journey-result-heading">
        <div>
          <h2>{documentLabels[locale][document.kind]}</h2>
          <p>
            <LockKeyhole size={14} /> {text.readOnly}
          </p>
        </div>
        {document.confirmed && (
          <span className="journey-badge">
            <Check size={14} /> {text.confirm}
          </span>
        )}
      </header>
      {!pendingSide && (
        <ConsistencyResult
          report={document.consistency}
          documents={{ [document.kind]: document }}
          locale={locale}
          busy={busy}
          onRetake={onRetake ? (_kind, side) => onRetake(side) : undefined}
        />
      )}
      {missing.length > 0 && !pendingSide && (
        <div className="journey-alert journey-missing-action" role="alert">
          <TriangleAlert size={18} />
          <div>
            <strong>{text.missingTitle}</strong>
            <p>{missing.map((key) => fieldLabel(locale, key)).join(" · ")}.</p>
            {suggestedSide && onRetake && (
              <button
                type="button"
                className="journey-primary"
                disabled={cannotRetake(suggestedSide)}
                onClick={() => onRetake(suggestedSide)}
              >
                <RotateCcw size={17} /> {text.retake} — {sideLabel(locale, suggestedSide)}
              </button>
            )}
          </div>
        </div>
      )}
      {!hasSideFields && !document.consistency?.blocking && !suggestedSide && onRetake && document.requiredSides.length > 1 && (
        <div className="journey-side-actions">
          {document.requiredSides.map((side) => (
            <button
              type="button"
              className="journey-text-button"
              key={side}
              disabled={cannotRetake(side)}
              onClick={() => onRetake(side)}
            >
              <RotateCcw size={15} /> {text.retake} — {sideLabel(locale, side)}
            </button>
          ))}
        </div>
      )}
      {!document.consistency?.blocking && <div className="journey-side-list">
        {groups.map(({ side, fields }) => (
          <section className="journey-side" key={side}>
            <div className="journey-side-heading">
              <h3>{hasSideFields ? sideLabel(locale, side) : text.allFields}</h3>
              {onRetake && !suggestedSide && document.requiredSides.includes(side) && side !== pendingSide && (
                <button
                  type="button"
                  className="journey-text-button"
                  disabled={cannotRetake(side)}
                  onClick={() => onRetake(side)}
                >
                  <RotateCcw size={15} /> {text.retake}
                </button>
              )}
            </div>
            {side === pendingSide ? (
              <output className="journey-side-pending">
                <LoaderCircle size={19} className="journey-spin" />
                <span>{pendingStage ? text.stage[pendingStage] : text.waiting}</span>
              </output>
            ) : (
              <dl className="journey-values">
                {visibleFields(fields).length ? (
                  visibleFields(fields).map(([key, value]) => (
                    <div key={key}>
                      <dt>{fieldLabel(locale, key)}</dt>
                      <dd dir={value && /[\u0600-\u06ff]/.test(value) ? "rtl" : "ltr"}>{value || text.missingValue}</dd>
                    </div>
                  ))
                ) : (
                  <div className="journey-values-empty">{text.missingValue}</div>
                )}
              </dl>
            )}
          </section>
        ))}
      </div>}
      {onConfirm && document.status === "ready" && (
        <div className="journey-result-footer">
          <button
            type="button"
            className="journey-primary"
            disabled={busy || document.consistency?.blocking}
            onClick={onConfirm}
          >
            <Check size={16} /> {text.confirm}
          </button>
        </div>
      )}
    </article>
  );
}
