import type { ModelListItem, ModelVariant } from "@cursor/sdk";

/** Every combination of the given params, like Cursor's catalog; `max` marks Max-mode variants. */
function variants(
  name: string,
  params: Record<string, string[]>,
  defaults: Record<string, string>,
  max: (p: Record<string, string>) => boolean = () => false,
): ModelVariant[] {
  let combos: Record<string, string>[] = [{}];
  for (const [k, vs] of Object.entries(params))
    combos = combos.flatMap((c) => vs.map((v) => ({ ...c, [k]: v })));
  return combos.map((c) => ({
    params: Object.entries(c).map(([id, value]) => ({ id, value })),
    displayName: name,
    ...(Object.entries(defaults).every(([k, v]) => c[k] === v) && { isDefault: true }),
    ...(max(c) && { isMaxMode: true }),
  }));
}

const def = (id: string, values: string[]) => ({ id, values: values.map((value) => ({ value })) });

/** Shapes taken from Cursor's live catalog (Nov 2026): 18-40 variants per Claude model, all named alike. */
export const CATALOG: ModelListItem[] = [
  {
    id: "claude-sonnet-5",
    displayName: "Claude Sonnet 5",
    parameters: [
      def("thinking", ["false", "true"]),
      def("context", ["300k", "1m"]),
      def("effort", ["low", "medium", "high", "xhigh", "max"]),
    ],
    variants: variants(
      "Claude Sonnet 5",
      {
        thinking: ["false", "true"],
        context: ["300k", "1m"],
        effort: ["low", "medium", "high", "xhigh", "max"],
      },
      { thinking: "true", context: "1m", effort: "high" },
      (c) => c.context === "1m",
    ),
  },
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    parameters: [
      def("context", ["272k", "1m"]),
      def("reasoning", ["none", "low", "medium", "high", "extra-high"]),
      def("fast", ["false", "true"]),
    ],
    variants: variants(
      "GPT-5.5",
      {
        context: ["272k", "1m"],
        reasoning: ["none", "low", "medium", "high", "extra-high"],
        fast: ["false", "true"],
      },
      { context: "1m", reasoning: "medium", fast: "false" },
      (c) => c.context === "1m",
    ),
  },
  {
    id: "composer-2.5",
    displayName: "Composer 2.5",
    parameters: [def("fast", ["false", "true"])],
    variants: variants("Composer 2.5", { fast: ["false", "true"] }, { fast: "true" }),
  },
  { id: "default", displayName: "Auto", variants: [{ params: [], displayName: "Auto", isDefault: true }] },
];
