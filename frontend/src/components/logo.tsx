export function Logo({ inverse = false }: { inverse?: boolean }) {
  return (
    <div className="brand" role="img" aria-label="OCR Onboarding">
      <span className={inverse ? "brand-mark inverse" : "brand-mark"}>O</span>
      <span>OCR Onboarding</span>
    </div>
  );
}
