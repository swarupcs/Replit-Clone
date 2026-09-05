import { useMemo, useRef } from "react";
import type { ReactNode } from "react";
import {
  SiFastapi,
  SiFlask,
  SiGo,
  SiHtml5,
  SiNextdotjs,
  SiNodedotjs,
  SiReact,
  SiSvelte,
  SiTypescript,
  SiVuedotjs,
} from "react-icons/si";
import { VscCheck, VscCode } from "react-icons/vsc";
import { Segmented } from "antd";
import type { CreateVariant, TemplateSummary } from "@replit-clone/shared";

/** What the picker needs to draw a template that the API does not send.
 *
 *  `TemplateSummary` carries an id, a label, ports and a start command — the
 *  facts the server owns. The brand mark, its tint and the one-line "what is
 *  this for" are presentation, so they live here rather than being invented on
 *  the server and shipped over the wire. */
interface TemplateLook {
  icon: ReactNode;
  /** The brand's colour, used for the icon and its tile wash. */
  tint: string;
  /** One line, lowercase-ish, answering "what do I get". */
  blurb: string;
  /** Which heading the card sits under. */
  group: Group;
  /** Marks the template as TypeScript, so the pair reads as one choice with a
   *  variant rather than two unrelated entries. */
  typescript?: boolean;
}

type Group = "Frontend" | "Fullstack" | "Backend" | "Static";

/** Order the headings appear in, not the order the API returns. */
const GROUP_ORDER: Group[] = ["Frontend", "Fullstack", "Backend", "Static"];

const LOOKS: Record<string, TemplateLook> = {
  "react-vite": {
    icon: <SiReact />,
    tint: "#61dafb",
    blurb: "Vite dev server, instant HMR",
    group: "Frontend",
  },
  "react-vite-ts": {
    icon: <SiReact />,
    tint: "#61dafb",
    blurb: "Vite with types wired up",
    group: "Frontend",
    typescript: true,
  },
  "vue-vite": {
    icon: <SiVuedotjs />,
    tint: "#42b883",
    blurb: "Single-file components on Vite",
    group: "Frontend",
  },
  "svelte-vite": {
    icon: <SiSvelte />,
    tint: "#ff3e00",
    blurb: "Compiled components, no runtime",
    group: "Frontend",
  },
  nextjs: {
    icon: <SiNextdotjs />,
    tint: "#e8eaf2",
    blurb: "App router, server components",
    group: "Fullstack",
  },
  "nextjs-ts": {
    icon: <SiNextdotjs />,
    tint: "#e8eaf2",
    blurb: "App router with types wired up",
    group: "Fullstack",
    typescript: true,
  },
  "node-express": {
    icon: <SiNodedotjs />,
    tint: "#5fa04e",
    blurb: "Minimal HTTP API and routes",
    group: "Backend",
  },
  "node-express-ts": {
    icon: <SiNodedotjs />,
    tint: "#5fa04e",
    blurb: "HTTP API with types wired up",
    group: "Backend",
    typescript: true,
  },
  "python-flask": {
    icon: <SiFlask />,
    tint: "#cbd0e0",
    blurb: "Small Python web framework",
    group: "Backend",
  },
  "python-fastapi": {
    icon: <SiFastapi />,
    tint: "#05998b",
    blurb: "Typed Python API with docs",
    group: "Backend",
  },
  "go-http": {
    icon: <SiGo />,
    tint: "#00add8",
    blurb: "Standard library, no dependencies",
    group: "Backend",
  },
  "static-html": {
    icon: <SiHtml5 />,
    tint: "#e34f26",
    blurb: "One page, no build step",
    group: "Static",
  },
};

/** A template the registry gained after this file was written still renders —
 *  as a plain card under Backend rather than not at all. */
const FALLBACK: TemplateLook = {
  icon: <VscCode />,
  tint: "var(--rc-accent)",
  blurb: "Starter project",
  group: "Backend",
};

function look(id: string): TemplateLook {
  return LOOKS[id] ?? FALLBACK;
}

interface TemplatePickerProps {
  templates: TemplateSummary[];
  value: string;
  onChange: (id: string) => void;
  /** Omitted by callers that do not offer the choice, in which case no toggle
   *  is rendered at all rather than a disabled one. */
  variant?: CreateVariant;
  onVariantChange?: (variant: CreateVariant) => void;
}

/** The grid of starting points in the New playground dialog.
 *
 *  This was a vertical `Segmented` — twelve centred text rows, no icons, no
 *  grouping, and the description of the selected one printed underneath. It
 *  read as a list of strings rather than a choice between things. Cards carry
 *  the brand mark, what the template gives you and where it runs, so the
 *  decision can be made by scanning instead of by reading.
 */
export const TemplatePicker = ({
  templates,
  value,
  onChange,
  variant = "starter",
  onVariantChange,
}: TemplatePickerProps) => {
  const gridRef = useRef<HTMLDivElement>(null);
  const active = templates.find((template) => template.id === value);

  /** Grouped in a fixed order, and only for headings that have members — a
   *  deployment whose registry drops every Python template should not be left
   *  with an empty "Backend" label. */
  const groups = useMemo(() => {
    const byGroup = new Map<Group, TemplateSummary[]>();

    for (const template of templates) {
      const { group } = look(template.id);
      const existing = byGroup.get(group);
      if (existing) existing.push(template);
      else byGroup.set(group, [template]);
    }

    return GROUP_ORDER.flatMap((group) => {
      const members = byGroup.get(group);
      return members ? [{ group, members }] : [];
    });
  }, [templates]);

  /** Arrow keys move between cards, the way a radio group is expected to.
   *
   *  Only the selected card is in the tab order, so tabbing past the picker
   *  takes one press rather than twelve. */
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const deltas: Record<string, number> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
    };
    const delta = deltas[event.key];
    if (delta === undefined) return;

    const index = templates.findIndex((template) => template.id === value);
    const next = templates[index + delta];
    if (!next) return;

    event.preventDefault();
    onChange(next.id);
    // Selection moved, so focus follows it — otherwise the ring stays on a
    // card that is no longer chosen.
    gridRef.current
      ?.querySelector<HTMLButtonElement>(`[data-template-id="${next.id}"]`)
      ?.focus();
  }

  return (
    <div
      ref={gridRef}
      role="radiogroup"
      aria-label="Starting point"
      onKeyDown={handleKeyDown}
      className="rc-template-groups"
    >
      {groups.map(({ group, members }) => (
        <div key={group}>
          <div className="rc-template-group-label">{group}</div>

          <div className="rc-template-grid">
            {members.map((template) => {
              const { icon, tint, blurb, typescript } = look(template.id);
              const selected = template.id === value;

              return (
                <button
                  key={template.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  data-template-id={template.id}
                  data-selected={selected}
                  className="rc-template-card"
                  onClick={() => onChange(template.id)}
                >
                  <span
                    className="rc-template-mark"
                    style={{
                      color: tint,
                      // The tile takes its wash from the brand colour rather
                      // than a fixed grey, so twelve cards do not read as one
                      // undifferentiated block.
                      background: `color-mix(in srgb, ${tint} 14%, transparent)`,
                    }}
                    aria-hidden
                  >
                    {icon}
                  </span>

                  <span className="rc-template-body">
                    <span className="rc-template-name">
                      {template.label}
                      {typescript && (
                        <SiTypescript
                          size={11}
                          color="#3178c6"
                          title="TypeScript"
                        />
                      )}
                    </span>
                    <span className="rc-template-blurb">{blurb}</span>
                  </span>

                  <span className="rc-template-check" aria-hidden>
                    {selected && <VscCheck size={12} />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {/* Only for templates that actually have a recipe. A toggle offered on
          `go-http`, where "latest" means nothing, is a control that does
          nothing -- and the server answers this from its recipe table, so a
          recipe turned off because upstream changed a flag also removes the
          option that would now fail. */}
      {onVariantChange && active?.latestAvailable && (
        <div className="rc-template-variant">
          <Segmented
            size="small"
            aria-label="How to build it"
            value={variant}
            onChange={(next) => {
              onVariantChange(next as CreateVariant);
            }}
            options={[
              { label: "Starter", value: "starter" },
              { label: "Latest", value: "latest" },
            ]}
          />
          {/* Says what each one costs, because the difference is not visible
              anywhere else until one of them takes two minutes. */}
          <span className="rc-template-variant-hint">
            {variant === "latest"
              ? `Runs ${active.label}'s own setup tool, so the versions are today's. Needs the network and takes a minute or two.`
              : "A pinned copy that is ready instantly and works offline. The versions are the ones this platform ships."}
          </span>
        </div>
      )}
    </div>
  );
};
