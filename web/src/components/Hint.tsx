import { Info } from "lucide-react";

/** Small info icon that explains a metric on hover. */
export function Hint({ text }: { text: string }) {
  return (
    <span className="hint" title={text} aria-label={text} role="img">
      <Info size={13} strokeWidth={1.5} />
    </span>
  );
}
