import { DesktopJourney } from "./desktop-journey";

export default async function SessionPage({ params }: { params: Promise<{ token: string }> }) {
  return <DesktopJourney token={(await params).token} />;
}
