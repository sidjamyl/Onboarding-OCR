import { PhoneCapture } from "./phone-capture";

export default async function CapturePage({ params }: { params: Promise<{ token: string }> }) {
  return <PhoneCapture token={(await params).token} />;
}
