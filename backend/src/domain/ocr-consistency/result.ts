/**
 * Four outcomes, per the validation catalogue:
 *
 *  passed      — the check ran and the value satisfied it
 *  warning     — suspicious but the data is still usable; never discards it
 *  failed      — hard error; triggers targeted re-extraction or a rescan
 *  not_checked — the check could not run: required input was null, only one
 *                card side was supplied, or no authoritative source exists for
 *                the rule (Algeria's NIN control key, the municipality table,
 *                the front/back document-number relationship)
 *
 * `not_checked` is load-bearing. It is the difference between "we verified this
 * and it is fine" and "we never looked" — collapsing those two into `passed` is
 * how a validation layer ends up lying about how much it verified.
 */
export type CheckOutcome = "passed" | "warning" | "failed" | "not_checked";

export interface Check {
  /** Stable id, e.g. "mrz.td1.composite_check_digit". Safe to alert on. */
  id: string;
  outcome: CheckOutcome;
  /** Human-readable explanation. Never contains raw document values. */
  detail: string;
  /** Schema field this concerns, when it maps to exactly one. */
  field?: string;
}

export type ReportStatus = "passed" | "warning" | "failed";

export interface ValidationReport {
  status: ReportStatus;
  checks: Check[];
  counts: Record<CheckOutcome, number>;
  /** Fields implicated by failed checks — the input to a targeted retry. */
  failedFields: string[];
  /** Fields implicated by warnings; surfaced for manual review. */
  warnedFields: string[];
}

export class CheckCollector {
  private readonly checks: Check[] = [];

  pass(id: string, detail: string, field?: string): void {
    this.push({ id, outcome: "passed", detail, ...(field ? { field } : {}) });
  }

  warn(id: string, detail: string, field?: string): void {
    this.push({ id, outcome: "warning", detail, ...(field ? { field } : {}) });
  }

  fail(id: string, detail: string, field?: string): void {
    this.push({ id, outcome: "failed", detail, ...(field ? { field } : {}) });
  }

  /** The value wasn't there, or no authoritative rule exists to check it against. */
  skip(id: string, detail: string, field?: string): void {
    this.push({ id, outcome: "not_checked", detail, ...(field ? { field } : {}) });
  }

  /** Convenience: pass when the predicate holds, otherwise fail. */
  assert(ok: boolean, id: string, detail: string, field?: string): boolean {
    if (ok) this.pass(id, detail, field);
    else this.fail(id, detail, field);
    return ok;
  }

  /** Convenience: pass when the predicate holds, otherwise warn. */
  expect(ok: boolean, id: string, detail: string, field?: string): boolean {
    if (ok) this.pass(id, detail, field);
    else this.warn(id, detail, field);
    return ok;
  }

  /**
   * Guard for a nullable input. Returns false and records `not_checked` when the
   * value is absent, so callers read as: `if (!c.present(v, id, field)) return;`
   */
  present<T>(value: T | null | undefined, id: string, field?: string): value is T {
    if (value === null || value === undefined) {
      this.skip(id, "required input was null or unreadable", field);
      return false;
    }
    return true;
  }

  merge(other: Check[]): void {
    for (const check of other) this.push(check);
  }

  list(): Check[] {
    return [...this.checks];
  }

  private push(check: Check): void {
    this.checks.push(check);
  }
}

export function buildReport(checks: Check[]): ValidationReport {
  const counts: Record<CheckOutcome, number> = {
    passed: 0,
    warning: 0,
    failed: 0,
    not_checked: 0,
  };
  const failedFields = new Set<string>();
  const warnedFields = new Set<string>();

  for (const check of checks) {
    counts[check.outcome]++;
    if (check.outcome === "failed" && check.field) failedFields.add(check.field);
    if (check.outcome === "warning" && check.field) warnedFields.add(check.field);
  }

  const status: ReportStatus =
    counts.failed > 0 ? "failed" : counts.warning > 0 ? "warning" : "passed";

  return {
    status,
    checks,
    counts,
    failedFields: [...failedFields],
    warnedFields: [...warnedFields],
  };
}

export function emptyReport(): ValidationReport {
  return buildReport([]);
}
