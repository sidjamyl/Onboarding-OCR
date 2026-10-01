"use client";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
export function Code({ title, children }: { title: string; children: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setError(false);
    } catch {
      setError(true);
    }
  }
  return (
    <div className="docs-code">
      <div className="docs-code-head">
        <span>{title}</span>
        <button type="button" onClick={() => void copy()} aria-label={`Copy ${title}`}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {error ? "Select code to copy" : copied ? "Copied" : "Copy"}
        </button>
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll long code examples. */}
      <pre tabIndex={0}>
        <code>{children}</code>
      </pre>
    </div>
  );
}
