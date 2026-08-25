/**
 * Pure helpers for the public status page.
 *
 * The page groups models by company, filters them, and rolls their statuses up
 * into headline counts. Keeping that logic here — rather than in the Svelte
 * template — makes it directly testable, and reuses the model catalog's single
 * provider classifier instead of a second copy of the same keyword rules.
 */
import { getProvider, type Provider } from "./models/catalog";
import type { PublicUptimeSummary, UptimeStatus } from "$contracts/uptime";

export type StatusFilter = "all" | "operational" | "degraded" | "down";

/** Worst first: the first entry present in a set is that set's headline status. */
const SEVERITY: readonly UptimeStatus[] = ["major", "degraded", "minor", "unknown", "operational"];

export interface GroupedStatusModels {
  provider: Provider;
  models: PublicUptimeSummary[];
  status: UptimeStatus;
}

export interface StatusTotals {
  total: number;
  operational: number;
  degraded: number;
  down: number;
}

export interface StatusQuery {
  query?: string;
  filter?: StatusFilter;
  /** An empty or absent set means "every provider". */
  providers?: ReadonlySet<Provider>;
}

export function statusMatchesFilter(status: UptimeStatus, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "operational") return status === "operational";
  if (filter === "degraded") return status === "minor" || status === "degraded";
  return status === "major" || status === "unknown";
}

/** The most severe status in the set, or "unknown" when the set is empty. */
export function worstStatus(statuses: Iterable<UptimeStatus>): UptimeStatus {
  let rank = SEVERITY.length;
  for (const status of statuses) {
    const next = SEVERITY.indexOf(status);
    if (next >= 0 && next < rank) rank = next;
  }
  return SEVERITY[rank] ?? "unknown";
}

/** "down" counts both outages and models with no traffic, matching the filter. */
export function statusTotals(models: readonly PublicUptimeSummary[]): StatusTotals {
  const totals: StatusTotals = { total: models.length, operational: 0, degraded: 0, down: 0 };
  for (const model of models) {
    if (statusMatchesFilter(model.status, "operational")) totals.operational += 1;
    else if (statusMatchesFilter(model.status, "degraded")) totals.degraded += 1;
    else totals.down += 1;
  }
  return totals;
}

export function providerCounts(models: readonly PublicUptimeSummary[]): Map<Provider, number> {
  const counts = new Map<Provider, number>();
  for (const model of models) {
    const provider = getProvider(model.model_name);
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  return new Map([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function groupStatusModels(
  models: readonly PublicUptimeSummary[],
  { query = "", filter = "all", providers }: StatusQuery = {},
): GroupedStatusModels[] {
  const normalized = query.trim().toLowerCase();
  const groups = new Map<Provider, PublicUptimeSummary[]>();

  for (const model of models) {
    if (!statusMatchesFilter(model.status, filter)) continue;
    const provider = getProvider(model.model_name);
    if (providers && providers.size > 0 && !providers.has(provider)) continue;
    if (normalized && !`${model.model_name} ${provider}`.toLowerCase().includes(normalized)) continue;
    const group = groups.get(provider);
    if (group) group.push(model);
    else groups.set(provider, [model]);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([provider, grouped]) => ({
      provider,
      models: [...grouped].sort((left, right) => left.model_name.localeCompare(right.model_name)),
      status: worstStatus(grouped.map((model) => model.status)),
    }));
}
