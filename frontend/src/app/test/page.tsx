import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LocalTest } from "./local-test";
import "../workspace.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Local document test · OCR Onboarding",
  robots: { index: false, follow: false },
};

export default function TestPage() {
  if (process.env.DEMO_MODE_ENABLED !== "true") notFound();
  return <LocalTest />;
}
