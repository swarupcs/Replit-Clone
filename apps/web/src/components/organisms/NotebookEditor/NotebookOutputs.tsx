import type { NotebookOutput } from "@replit-clone/shared";
import { renderBundle, stripAnsi } from "../../../lib/notebookOutput.ts";

/** One code cell's outputs, in the order the kernel produced them.
 *
 *  plan.md §12.3. Order is the content here: a cell that prints, plots, then
 *  raises produced those three things in that sequence, and grouping them by
 *  kind would misreport what happened.
 */

function Bundle({
  data,
  metadata,
}: {
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}) {
  const rendered = renderBundle(data);

  if (rendered.kind === "image") {
    // Sized from the notebook's own metadata when it has any -- matplotlib
    // writes `image/png` dimensions there -- so a figure saved at 2x does not
    // arrive twice the size it was authored at.
    const size = metadata[Object.keys(data).find((key) => key.startsWith("image/")) ?? ""];
    const dims =
      typeof size === "object" && size !== null
        ? (size as { width?: number; height?: number })
        : {};

    return (
      <img
        className="rc-nb-output-image"
        src={rendered.src}
        alt={rendered.alt}
        width={dims.width}
        height={dims.height}
      />
    );
  }

  if (rendered.kind === "text") {
    return <pre className="rc-nb-output-text">{rendered.text}</pre>;
  }

  return (
    <div className="rc-nb-output-unsupported">
      This output is {rendered.types.join(", ") || "empty"}, which this editor
      does not render.
    </div>
  );
}

export function NotebookOutputs({ outputs }: { outputs: NotebookOutput[] }) {
  if (outputs.length === 0) return null;

  return (
    <div className="rc-nb-outputs" aria-label="Cell output">
      {outputs.map((output, index) => {
        if (output.output_type === "stream") {
          return (
            <pre
              key={index}
              className="rc-nb-output-text"
              // stderr is tinted, not marked as an error: warnings and tqdm
              // progress bars both live here, and a cell that ran fine would
              // otherwise look broken. See `isFailure`.
              data-stream={output.name}
            >
              {stripAnsi(output.source)}
            </pre>
          );
        }

        if (output.output_type === "error") {
          return (
            <div key={index} className="rc-nb-output-error" role="alert">
              {/* The name and value first, on their own line. A traceback's
                  most useful line is its last, and a long one pushes it off
                  the bottom -- so the answer to "what went wrong" is stated
                  before the frames that lead to it. */}
              <div className="rc-nb-error-headline">
                {output.ename}: {output.evalue}
              </div>
              {output.traceback.length > 0 && (
                <pre className="rc-nb-output-text">
                  {stripAnsi(output.traceback.join("\n"))}
                </pre>
              )}
            </div>
          );
        }

        return (
          <Bundle key={index} data={output.data} metadata={output.metadata} />
        );
      })}
    </div>
  );
}
