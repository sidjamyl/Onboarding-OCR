import type { Metadata } from "next";
import { AdminPanel } from "./panel";
import "../workspace.css";
export const metadata: Metadata = { title: "Applications · OCR Onboarding", robots: { index: false, follow: false } };
export default function AdminPage() {
  return <AdminPanel />;
}
