import { notFound } from "next/navigation";
import { CalibrationCapture } from "./phone-capture";

export default function CalibrationCapturePage() {
  if (process.env.NEXT_PUBLIC_QUALITY_LAB_ENABLED !== "true") notFound();
  return <CalibrationCapture />;
}
