"use client";

import { LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { cameraCopy, hintCopy } from "@/lib/capture-copy";
import type { CaptureHint, QualityProfile } from "@/lib/quality-core";
import type { Locale, QualityReport } from "@/lib/types";
import { type DocumentCapture, DocumentCamera } from "./document-camera";

type Props = {
  locale: Locale;
  documentKind: string;
  documentLabel: string;
  sideLabel: string;
  attemptsRemaining: number;
  profileUrl: string;
  serverError: QualityReport | { error: string } | null;
  onCapture: (capture: DocumentCapture) => Promise<void>;
  onRetake: () => void;
  onBack: () => void;
  onSimulate?: () => Promise<void>;
};

/** Loads the session's quality profile, then hands over to the full-screen document camera. */
export function CaptureStep({ profileUrl, locale, serverError, ...props }: Props) {
  const [profile, setProfile] = useState<QualityProfile>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(profileUrl, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || !payload.qualityProfile) throw new Error("Quality configuration is unavailable");
        if (active) setProfile(payload.qualityProfile);
      })
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [profileUrl]);

  if (failed)
    return (
      <div className="capture-step-state" role="alert">
        <TriangleAlert size={24} />
        <p>{bootstrapFailure[locale]}</p>
      </div>
    );
  if (!profile)
    return (
      <div className="capture-step-state">
        <LoaderCircle size={22} className="spin-icon" />
        <p>{cameraCopy[locale].starting}</p>
      </div>
    );
  return (
    <DocumentCamera
      {...props}
      locale={locale}
      profile={profile}
      serverError={serverError ? serverMessage(serverError, locale) : null}
      serverRetryable={Boolean(
        serverError &&
          "error" in serverError &&
          !["document_not_verified", "capture_unreadable"].includes(serverError.error),
      )}
    />
  );
}

/** The server returns the first actionable hint; older reports fall back to their first failed check. */
function serverMessage(report: QualityReport | { error: string }, locale: Locale) {
  if ("error" in report) {
    if (report.error === "capture_unreadable") return retakeCopy[locale];
    return report.error === "document_not_verified" ? verificationCopy[locale] : technicalCopy[locale];
  }
  const hint = (report.hint ?? report.checks.find((check) => check.status === "fail")?.hint) as CaptureHint | undefined;
  return hint && hint !== "ready" ? hintCopy[locale][hint] : retakeCopy[locale];
}

const verificationCopy: Record<Locale, string> = {
  fr: "Le document ou la face attendue n’a pas pu être reconnu. Vérifiez la bonne face, cadrez tout le document et reprenez la photo.",
  en: "The expected document or side could not be verified. Check the side, frame the whole document, and retake the photo.",
  ar: "تعذر التحقق من الوثيقة أو الوجه المطلوب. تأكد من الوجه الصحيح وأظهر الوثيقة كاملة ثم أعد التقاط الصورة.",
};
const technicalCopy: Record<Locale, string> = {
  fr: "La vérification est momentanément indisponible. Vérifiez votre connexion et réessayez avec cette photo.",
  en: "Verification is temporarily unavailable. Check your connection and retry with this photo.",
  ar: "التحقق غير متاح مؤقتًا. تحقق من اتصالك وأعد المحاولة باستخدام هذه الصورة.",
};

const bootstrapFailure: Record<Locale, string> = {
  fr: "Les réglages de contrôle photo sont indisponibles. Rechargez la page.",
  en: "Photo quality settings are unavailable. Reload the page.",
  ar: "إعدادات جودة الصورة غير متاحة. أعد تحميل الصفحة.",
};

const retakeCopy: Record<Locale, string> = {
  fr: "Cette photo ne peut pas être lue. Reprenez-la.",
  en: "This photo cannot be read. Please retake it.",
  ar: "تعذرت قراءة هذه الصورة. أعد التقاطها.",
};
