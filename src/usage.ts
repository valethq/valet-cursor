import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginContext, Display, SettingsTone } from "@valethq/sdk";
import type { CursorConfig } from "./config";

/** Pace within this many points of an even burn-down counts as "on pace". */
const PACE_SLACK = 5;
/** A cached reading newer than this is reused. */
const FRESH_MS = 60_000;
/** After a failed read, wait this long before trying again on its own. */
const RETRY_MS = 5 * 60_000;
/** "Refresh now" within this long of the last read is ignored. */
const MANUAL_GAP_MS = 10_000;
const FETCH_TIMEOUT_MS = 20_000;
/** How long the first view waits for a reading before showing "Reading usage". */
const FIRST_WAIT_MS = 3_000;
/** How long an exchanged access token is reused. It is never written to disk. */
const TOKEN_MS = 30 * 60_000;
/** Cursor's GetHardLimit uses 2^31-1 as "no cap". The field is dollars, not cents. */
const UNLIMITED_HARD_LIMIT = 2_147_483_647;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

export interface IncludedUsage {
  /** Share used, 0-100. */
  percent: number;
  /** Epoch ms the included bucket resets. */
  resetsAt?: number;
  /** Epoch ms the current bucket started. Together with `resetsAt` this is the pace window. */
  periodStart?: number;
  autoPercent?: number;
  apiPercent?: number;
}

export type OnDemand =
  | { kind: "fixed"; usedDollars: number; limitDollars: number }
  | { kind: "unlimited"; usedDollars: number; scope?: "personal" | "team-member" }
  | { kind: "disabled"; usedDollars: number }
  | { kind: "unavailable"; usedDollars: number };

export interface UsageSnapshot {
  available: boolean;
  /** A login exists, but this plan has no included-usage bucket. */
  unsupported?: boolean;
  plan?: string;
  included?: IncludedUsage;
  onDemand?: OnDemand;
}

const fromIndividual = (limitCents: number | undefined, usedDollars: number): OnDemand | undefined => {
  if (limitCents === undefined) return undefined;
  return limitCents > 0
    ? { kind: "fixed", usedDollars, limitDollars: limitCents / 100 }
    : { kind: "disabled", usedDollars };
};

/** Same on-demand rules as the Cursor CLI usage view. */
export function onDemandOf(period: Obj, hard: Obj | undefined): OnDemand {
  const spend = isObj(period.spendLimitUsage) ? period.spendLimitUsage : {};
  const usedDollars = (num(spend.individualUsed) ?? 0) / 100;
  const individual = fromIndividual(num(spend.individualLimit), usedDollars);
  if (spend.limitType === "team") {
    if (individual) return individual;
    if (hard) {
      if (hard.noUsageBasedAllowed === true || (num(hard.hardLimit) ?? 0) <= 0)
        return { kind: "disabled", usedDollars };
      return { kind: "unlimited", usedDollars, scope: "team-member" };
    }
    if ((num(spend.pooledLimit) ?? 0) > 0) return { kind: "unlimited", usedDollars, scope: "team-member" };
    return { kind: "unavailable", usedDollars };
  }
  if (!hard) return individual ?? { kind: "unavailable", usedDollars };
  if (hard.noUsageBasedAllowed === true) return { kind: "disabled", usedDollars };
  const hardLimit = num(hard.hardLimit) ?? 0;
  if (hardLimit >= UNLIMITED_HARD_LIMIT) return { kind: "unlimited", usedDollars, scope: "personal" };
  if (hardLimit > 0) return { kind: "fixed", usedDollars, limitDollars: hardLimit };
  return { kind: "disabled", usedDollars };
}

/**
 * `plan` is GetPlanInfo, `period` is GetCurrentPeriodUsage, `hard` is GetHardLimit.
 * `hard` undefined means that call failed; an object (even `{}`) means it succeeded
 * and omitted proto3 defaults, so a missing hardLimit is 0.
 */
export function parseUsage(raw: { plan?: unknown; period?: unknown; hard?: unknown }): UsageSnapshot {
  const planBody = isObj(raw.plan) ? raw.plan : {};
  const planInfo = isObj(planBody.planInfo) ? planBody.planInfo : undefined;
  const plan = typeof planInfo?.planName === "string" && planInfo.planName ? planInfo.planName : undefined;
  const named = plan !== undefined ? { plan } : {};
  const period = isObj(raw.period) ? raw.period : undefined;
  const usage = period && isObj(period.planUsage) ? period.planUsage : undefined;
  if (!period || !usage) return { available: false, unsupported: true, ...named };

  const spend = num(usage.includedSpend) ?? 0;
  const cap = num(usage.limit) ?? 0;
  const reported = num(usage.totalPercentUsed);
  const percent = reported !== undefined ? reported : cap > 0 ? (spend / cap) * 100 : 0;
  const resetsAt =
    num(period.billingCycleEnd) || num(planInfo?.billingCycleEnd) || num(planInfo?.includedUsageResetsAt);
  const periodStart = num(period.billingCycleStart);
  const autoPercent = num(usage.autoPercentUsed);
  const apiPercent = num(usage.apiPercentUsed);
  const hard = isObj(raw.hard) ? raw.hard : undefined;
  return {
    available: true,
    ...named,
    included: {
      percent,
      ...(resetsAt !== undefined && resetsAt > 0 && { resetsAt }),
      ...(periodStart !== undefined && periodStart > 0 && { periodStart }),
      ...(autoPercent !== undefined && { autoPercent }),
      ...(apiPercent !== undefined && { apiPercent }),
    },
    onDemand: onDemandOf(period, hard),
  };
}

const capitalize = (s: string) => (s ? (s[0]?.toUpperCase() ?? "") + s.slice(1) : s);

/** Time left until `resetsAt` (epoch ms). */
export function untilReset(resetsAt: number, now: number): string {
  const mins = Math.max(0, Math.round((resetsAt - now) / 60_000));
  if (mins < 1) return "less than a minute";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const rh = h % 24;
  return rh ? `${Math.floor(h / 24)}d ${rh}h` : `${Math.floor(h / 24)}d`;
}

const toneFor = (used: number): SettingsTone =>
  used >= 100 ? "critical" : used >= 90 ? "warning" : "normal";

const money = (n: number): string => {
  const digits = Number.isInteger(n) ? 0 : 2;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

/** The bar shows what is left; the marker is where an even burn-down would be. */
export function includedMeter(u: IncludedUsage, now: number): Display {
  const used = Math.round(Math.min(100, Math.max(0, u.percent)));
  const left = 100 - used;
  const remaining = u.resetsAt === undefined ? 0 : Math.max(0, u.resetsAt - now);
  const span =
    u.periodStart !== undefined && u.resetsAt !== undefined && u.resetsAt > u.periodStart
      ? u.resetsAt - u.periodStart
      : undefined;
  const pace = remaining > 0 && span !== undefined;
  const burned = pace ? Math.min(100, Math.max(0, (1 - remaining / span) * 100)) : 0;
  const status = !pace
    ? undefined
    : used > burned + PACE_SLACK
      ? "Over pace"
      : used < burned - PACE_SLACK
        ? "Under pace"
        : "On pace";
  const reset = u.resetsAt === undefined ? "" : untilReset(u.resetsAt, now);
  return {
    type: "meter",
    label: "Included",
    value: left,
    display: `${left}% left`,
    ...(remaining > 0 && { caption: used > 0 ? `+${used}% in ${reset}` : `Resets in ${reset}` }),
    ...(status && { status }),
    ...(pace && { marker: 100 - burned }),
    tone: toneFor(used),
  };
}

function bucketMeter(label: string, percent: number): Display {
  const used = Math.round(Math.min(100, Math.max(0, percent)));
  return {
    type: "meter",
    label,
    value: 100 - used,
    display: `${100 - used}% left`,
    tone: toneFor(used),
  };
}

export function onDemandBlock(o: OnDemand): Display {
  if (o.kind === "fixed") {
    const usedPct = o.limitDollars > 0 ? Math.min(100, (o.usedDollars / o.limitDollars) * 100) : 100;
    const left = Math.max(0, o.limitDollars - o.usedDollars);
    return {
      type: "meter",
      label: "On-demand",
      value: 100 - usedPct,
      display: `${money(o.usedDollars)} / ${money(o.limitDollars)}`,
      caption: `${money(left)} remaining`,
      tone: toneFor(usedPct),
    };
  }
  if (o.kind === "unlimited") {
    return {
      type: "stat",
      label: "On-demand",
      value: money(o.usedDollars),
      caption: o.scope === "team-member" ? "No personal limit" : "No monthly limit",
    };
  }
  if (o.kind === "disabled") {
    return {
      type: "stat",
      label: "On-demand",
      value: o.usedDollars > 0 ? money(o.usedDollars) : "Off",
      caption: "On-demand usage is off",
    };
  }
  return {
    type: "stat",
    label: "On-demand",
    value: o.usedDollars > 0 ? money(o.usedDollars) : "Unavailable",
    caption: "On-demand limit unavailable",
  };
}

export interface UsageState {
  snapshot?: UsageSnapshot;
  at?: number;
  error?: string;
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function usageBlocks(s: UsageState, now = Date.now()): Display[] {
  const out: Display[] = [];
  const snap = s.snapshot;
  if (!snap) {
    out.push({
      type: "note",
      text: s.error ? `Could not read usage: ${s.error}` : "Reading usage...",
      tone: s.error ? "warning" : "normal",
    });
  } else if (!snap.available) {
    out.push({
      type: "note",
      text: snap.unsupported
        ? snap.plan
          ? `Included usage is not available for the ${capitalize(snap.plan)} plan.`
          : "Included usage is not available for this plan."
        : "Plan usage needs a Cursor API key or a Cursor login.",
    });
  } else {
    const inc = snap.included;
    const blocks: Display[] = [
      ...(snap.plan ? [{ type: "badge" as const, text: capitalize(snap.plan) }] : []),
      ...(inc ? [includedMeter(inc, now)] : []),
    ];
    if (inc?.autoPercent !== undefined && Math.round(inc.autoPercent) !== Math.round(inc.percent))
      blocks.push(bucketMeter("Auto", inc.autoPercent));
    if (inc?.apiPercent !== undefined && inc.apiPercent > 0) blocks.push(bucketMeter("API", inc.apiPercent));
    if (snap.onDemand) blocks.push(onDemandBlock(snap.onDemand));
    out.push(...blocks);
    if (s.error) out.push({ type: "note", text: `Could not refresh usage: ${s.error}`, tone: "warning" });
  }
  if (snap || s.error)
    out.push(...(s.at === undefined ? [] : [{ type: "note" as const, text: `Updated ${clock(s.at)}` }]), {
      type: "action",
      text: "Refresh now",
      action: "refresh",
    });
  return out;
}

export interface UsageService {
  view(): Promise<Display[]>;
  refresh(force?: boolean): Promise<void>;
}

export interface UsageOptions {
  /** Valet secret, then CURSOR_API_KEY. The stored SDK login is tried after this. */
  key: () => Promise<string | undefined>;
  now?: () => number;
  fetch?: FetchLike;
  base?: string;
  storedKey?: () => Promise<string | undefined>;
}

const apiBase = () =>
  (process.env.CURSOR_API_ENDPOINT || process.env.CURSOR_API_BASE_URL || "https://api2.cursor.sh").replace(
    /\/+$/,
    "",
  );

/** The key `Cursor.auth.login()` writes to `~/.cursor/sdk/auth.json`, when it matches this backend. */
export async function readStoredSdkKey(
  base = apiBase(),
  now = Date.now(),
  path = join(homedir(), ".cursor", "sdk", "auth.json"),
): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isObj(raw) || raw.version !== 1 || typeof raw.apiKey !== "string" || raw.apiKey.length === 0)
      return undefined;
    if (typeof raw.backendUrl === "string" && raw.backendUrl.replace(/\/+$/, "") !== base) return undefined;
    if (typeof raw.apiKeyExpiresAtMs === "number" && raw.apiKeyExpiresAtMs <= now) return undefined;
    return raw.apiKey;
  } catch {
    return undefined;
  }
}

const bearer = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "connect-protocol-version": "1",
});

/**
 * Plan usage from the dashboard RPCs the Cursor CLI usage view calls.
 * The API key is exchanged for an access token; that token stays in memory.
 */
export function createUsage(ctx: PluginContext<CursorConfig>, opts: UsageOptions): UsageService {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetch ?? fetch;
  const base = (opts.base ?? apiBase()).replace(/\/+$/, "");
  const storedKey = opts.storedKey ?? (() => readStoredSdkKey(base, now()));
  const state: UsageState = {};
  let failedAt: number | undefined;
  let inflight: Promise<void> | undefined;
  let access: { key: string; token: string; at: number } | undefined;
  let exchanging: Promise<string> | undefined;

  async function request(url: string, token: string): Promise<Response> {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    try {
      return await fetchImpl(url, { method: "POST", headers: bearer(token), body: "{}", signal: timeout });
    } catch (error) {
      if (timeout.aborted) throw new Error("timed out reading usage");
      throw error;
    }
  }

  async function tokenFor(key: string, force = false): Promise<string> {
    const t = now();
    if (!force && access && access.key === key && t - access.at < TOKEN_MS) return access.token;
    if (!force && exchanging) return exchanging;
    const run = (async () => {
      const res = await request(`${base}/auth/exchange_user_api_key`, key);
      if (res.status === 401 || res.status === 403) throw new Error("Cursor API key was rejected");
      if (!res.ok) throw new Error(`Cursor login HTTP ${res.status}`);
      const body = (await res.json()) as unknown;
      const token = isObj(body) && typeof body.accessToken === "string" ? body.accessToken : "";
      if (!token) throw new Error("Cursor login returned no access token");
      access = { key, token, at: now() };
      return token;
    })();
    exchanging = run;
    try {
      return await run;
    } finally {
      if (exchanging === run) exchanging = undefined;
    }
  }

  async function dash(name: string, key: string): Promise<unknown> {
    const send = async (force: boolean) =>
      request(`${base}/aiserver.v1.DashboardService/${name}`, await tokenFor(key, force));
    let res = await send(false);
    if (res.status === 401) {
      access = undefined;
      res = await send(true);
    }
    if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  }

  async function read(): Promise<UsageSnapshot> {
    const key = (await opts.key()) ?? (await storedKey());
    if (!key) return { available: false };
    const period = await dash("GetCurrentPeriodUsage", key);
    const [plan, hard] = await Promise.all([
      dash("GetPlanInfo", key).catch(() => undefined),
      dash("GetHardLimit", key).catch(() => undefined),
    ]);
    return parseUsage({ plan, period, hard });
  }

  function refresh(force = false): Promise<void> {
    if (inflight) return inflight;
    const t = now();
    if (state.at !== undefined && t - state.at < (force ? MANUAL_GAP_MS : FRESH_MS)) return Promise.resolve();
    if (!force && failedAt !== undefined && t - failedAt < RETRY_MS) return Promise.resolve();
    inflight = read()
      .then((snapshot) => {
        state.snapshot = snapshot;
        state.at = now();
        delete state.error;
        failedAt = undefined;
      })
      .catch((error: unknown) => {
        state.error = error instanceof Error ? error.message : String(error);
        failedAt = now();
        ctx.log.warn("cursor usage read failed", { error: state.error });
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  return {
    refresh,
    async view() {
      const pending = refresh();
      if (!state.snapshot && !state.error) {
        let wait: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([pending, new Promise<void>((r) => (wait = setTimeout(r, FIRST_WAIT_MS)))]);
        clearTimeout(wait);
      }
      return usageBlocks(state, now());
    },
  };
}
