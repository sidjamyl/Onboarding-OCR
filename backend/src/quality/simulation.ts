import type { DocumentKind, OcrFields, QualityCheck, QualityReport } from "../domain/types.js";
import type { QualityProfile } from "./profile.js";

export function simulatedPassingQualityReport(profile: QualityProfile): QualityReport {
  const { image } = profile;
  const checks: QualityCheck[] = [
    passingCheck("sharpness", image.minSharpness * 2, `≥ ${image.minSharpness}`),
    passingCheck(
      "exposure",
      midpoint(image.exposureMin, image.exposureMax),
      `${image.exposureMin}–${image.exposureMax}`,
    ),
    passingCheck("glare", 0, `≤ ${image.maxGlareRatio}`),
    passingCheck("illumination", 1, `≥ ${image.minIllumination}`),
    passingCheck("template_alignment", "simulated", "valid template"),
  ];
  return {
    passed: true,
    mode: profile.mode,
    checks,
    templateMatched: true,
    templateId: "dev-simulation",
    hint: "ready",
    diagnostics: { selectedTemplateId: "dev-simulation" },
    durationMs: 0,
  };
}

export function simulatedOcrFields(kind: DocumentKind): OcrFields {
  return {
    lastNameLatin: "BENALI",
    firstNameLatin: "AMINE",
    lastNameArabic: "بن علي",
    firstNameArabic: "أمين",
    nin: "100012345678901234",
    documentNumber: simulatedDocumentNumber(kind),
    dateOfBirth: "1990-02-12",
    expiryDate: "2035-02-12",
  };
}

function passingCheck(key: string, value: number | string, threshold: number | string): QualityCheck {
  return { key, passed: true, status: "pass", value, threshold, message: "Simulated check passed", durationMs: 0 };
}

function midpoint(minimum: number, maximum: number) {
  return Math.round(((minimum + maximum) / 2) * 100) / 100;
}

function simulatedDocumentNumber(kind: DocumentKind) {
  if (kind === "dz-passport") return "SIM-PASSPORT-001";
  if (kind === "dz-driving-licence") return "SIM-LICENCE-001";
  return "SIM-ID-001";
}
