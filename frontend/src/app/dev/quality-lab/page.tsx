import { notFound } from "next/navigation";
import { QualityLab } from "./quality-lab";

export default function QualityLabPage() {
  if (process.env.NEXT_PUBLIC_QUALITY_LAB_ENABLED !== "true") notFound();
  return <QualityLab />;
}
