import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { fakeSdk, say } from "./fake-sdk";
import {
  createUsage,
  includedMeter,
  onDemandOf,
  parseUsage,
  readStoredSdkKey,
  untilReset,
  usageBlocks,
} from "../src/usage";

const START = 1_794_836_644_482;
const END = START + 7 * 86_400_000;
const NOW = END - 6 * 86_400_000;

/** The shape GetPlanInfo, GetCurrentPeriodUsage and GetHardLimit returned for a Premium login. */
const premium = () => ({
  plan: {
    planInfo: {
      planName: "Premium",
      price: "",
      billingCycleEnd: "1796692258378",
      includedUsagePeriod: "INCLUDED_USAGE_PERIOD_WEEKLY",
      includedUsageResetsAt: String(END),
    },
  },
  period: {
    billingCycleStart: String(START),
    billingCycleEnd: String(END),
    planUsage: {
      remainingBonus: false,
      autoPercentUsed: 72.93607800650054,
      totalPercentUsed: 72.93607800650054,
    },
    spendLimitUsage: { limitType: "user" },
    enabled: true,
    displayMessage: "You've used 73% of your included usage",
  },
  hard: { hardLimit: 2_147_483_647 },
});

describe("parseUsage", () => {
  test("reads the plan, the included bucket and an unlimited on-demand cap", () => {
    const s = parseUsage(premium());
    expect(s.available).toBe(true);
    expect(s.plan).toBe("Premium");
    expect(s.included?.percent).toBeCloseTo(72.936, 3);
    expect(s.included?.resetsAt).toBe(END);
    expect(s.included?.periodStart).toBe(START);
    expect(s.included?.autoPercent).toBeCloseTo(72.936, 3);
    expect(s.included?.apiPercent).toBeUndefined();
    expect(s.onDemand).toEqual({ kind: "unlimited", usedDollars: 0, scope: "personal" });
  });

  test("derives the percent from included spend when the server omits it", () => {
    const raw = premium();
    raw.period.planUsage = { includedSpend: 25, limit: 100 } as never;
    expect(parseUsage(raw).included?.percent).toBe(25);
  });

  test("a plan with no included bucket is unavailable, not an error", () => {
    const raw = premium();
    delete (raw.period as { planUsage?: unknown }).planUsage;
    expect(parseUsage(raw)).toMatchObject({ available: false, unsupported: true, plan: "Premium" });
    expect(parseUsage({}).available).toBe(false);
    expect(parseUsage({ period: "nope" }).unsupported).toBe(true);
  });
});

describe("onDemandOf", () => {
  const period = (spend: Record<string, unknown>) => ({ spendLimitUsage: spend });

  test("a dollar hard limit is a fixed cap; cents on the spend row are dollars", () => {
    expect(onDemandOf(period({ individualUsed: 2500, limitType: "user" }), { hardLimit: 50 })).toEqual({
      kind: "fixed",
      usedDollars: 25,
      limitDollars: 50,
    });
  });

  test("a missing hard limit on a successful body, or usage-based turned off, is disabled", () => {
    expect(onDemandOf(period({}), {})).toMatchObject({ kind: "disabled" });
    expect(onDemandOf(period({ individualUsed: 100 }), { hardLimit: 0 })).toMatchObject({
      kind: "disabled",
      usedDollars: 1,
    });
    expect(onDemandOf(period({}), { noUsageBasedAllowed: true, hardLimit: 100 })).toMatchObject({
      kind: "disabled",
    });
  });

  test("a team limit uses the individual cap, else the hard limit, else the pool", () => {
    expect(onDemandOf(period({ limitType: "team", individualLimit: 0 }), { hardLimit: 100 })).toMatchObject({
      kind: "disabled",
    });
    expect(onDemandOf(period({ limitType: "team", individualLimit: 1500 }), { hardLimit: 100 })).toEqual({
      kind: "fixed",
      usedDollars: 0,
      limitDollars: 15,
    });
    expect(onDemandOf(period({ limitType: "team" }), { hardLimit: 20 })).toEqual({
      kind: "unlimited",
      usedDollars: 0,
      scope: "team-member",
    });
    expect(onDemandOf(period({ limitType: "team", pooledLimit: 5 }), undefined)).toMatchObject({
      kind: "unlimited",
      scope: "team-member",
    });
    expect(onDemandOf(period({ limitType: "team" }), undefined)).toMatchObject({ kind: "unavailable" });
  });

  test("when the hard-limit call failed, an individual cap still counts", () => {
    expect(onDemandOf(period({ individualLimit: 1000, individualUsed: 250 }), undefined)).toEqual({
      kind: "fixed",
      usedDollars: 2.5,
      limitDollars: 10,
    });
    expect(onDemandOf(period({}), undefined)).toMatchObject({ kind: "unavailable" });
  });
});

describe("includedMeter", () => {
  test("73% used with most of a weekly bucket left is over pace", () => {
    const raw = parseUsage(premium());
    const inc = raw.included;
    if (!inc) throw new Error("missing included");
    expect(includedMeter(inc, NOW)).toEqual({
      type: "meter",
      label: "Included",
      value: 27,
      display: "27% left",
      caption: "+73% in 6d",
      status: "Over pace",
      marker: expect.closeTo(100 - (1 - 6 / 7) * 100, 5),
      tone: "normal",
    });
    expect(untilReset(NOW + 2 * 3_600_000, NOW)).toBe("2h");
  });

  test("an even burn is on pace, and a reset with nothing spent says when", () => {
    const raw = parseUsage(premium());
    const inc = raw.included;
    if (!inc) throw new Error("missing included");
    const mid = START + (END - START) / 2;
    expect(includedMeter({ ...inc, percent: 50 }, mid)).toMatchObject({ status: "On pace", value: 50 });
    expect(includedMeter({ ...inc, percent: 0 }, NOW)).toMatchObject({
      caption: "Resets in 6d",
      status: "Under pace",
    });
    expect(includedMeter({ percent: 10 }, NOW)).not.toHaveProperty("status");
  });
});

describe("usageBlocks", () => {
  test("plan, included meter, on-demand, then the update time and a refresh action", () => {
    const blocks = usageBlocks({ snapshot: parseUsage(premium()), at: NOW }, NOW);
    expect(blocks.map((b) => b.type)).toEqual(["badge", "meter", "stat", "note", "action"]);
    expect(blocks[0]).toMatchObject({ text: "Premium" });
    expect(blocks[2]).toMatchObject({ label: "On-demand", value: "$0", caption: "No monthly limit" });
    expect(blocks[4]).toEqual({ type: "action", text: "Refresh now", action: "refresh" });
  });

  test("auto and api rows appear only when they differ from the included total", () => {
    const raw = premium();
    raw.period.planUsage.autoPercentUsed = 10;
    (raw.period.planUsage as { apiPercentUsed?: number }).apiPercentUsed = 40;
    const blocks = usageBlocks({ snapshot: parseUsage(raw), at: NOW }, NOW);
    expect(blocks.filter((b) => b.type === "meter").map((b) => (b as { label?: string }).label)).toEqual([
      "Included",
      "Auto",
      "API",
    ]);
  });

  test("before the first reading, and when it failed", () => {
    expect(usageBlocks({}, NOW)).toEqual([{ type: "note", text: "Reading usage...", tone: "normal" }]);
    const failed = usageBlocks({ error: "boom" }, NOW);
    expect(failed[0]).toEqual({ type: "note", text: "Could not read usage: boom", tone: "warning" });
    expect(failed[1]).toMatchObject({ type: "action" });
  });

  test("a failed refresh keeps the last readings and says so", () => {
    const blocks = usageBlocks({ snapshot: parseUsage(premium()), at: NOW, error: "boom" }, NOW);
    expect(blocks.map((b) => b.type)).toEqual(["badge", "meter", "stat", "note", "note", "action"]);
  });

  test("no login, and a plan without included usage, say why and offer no meters", () => {
    const none = usageBlocks({ snapshot: { available: false }, at: NOW }, NOW);
    expect(none[0]).toEqual({
      type: "note",
      text: "Plan usage needs a Cursor API key or a Cursor login.",
    });
    const plan = usageBlocks({ snapshot: parseUsage({ plan: premium().plan, period: {} }), at: NOW }, NOW);
    expect(plan[0]).toEqual({
      type: "note",
      text: "Included usage is not available for the Premium plan.",
    });
    expect(JSON.stringify(none)).not.toContain('"meter"');
    expect(JSON.stringify(plan)).not.toContain('"meter"');
  });
});

describe("readStoredSdkKey", () => {
  test("returns the key only when it is unexpired and minted for this backend", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-auth-"));
    const path = join(dir, "auth.json");
    const write = (v: unknown) => writeFileSync(path, JSON.stringify(v));
    write({ version: 1, backendUrl: "https://api2.cursor.sh/", apiKey: "k", apiKeyExpiresAtMs: NOW + 1000 });
    expect(await readStoredSdkKey("https://api2.cursor.sh", NOW, path)).toBe("k");
    write({ version: 1, backendUrl: "https://api2.cursor.sh", apiKey: "k", apiKeyExpiresAtMs: NOW });
    expect(await readStoredSdkKey("https://api2.cursor.sh", NOW, path)).toBeUndefined();
    write({ version: 1, backendUrl: "https://other.example", apiKey: "k" });
    expect(await readStoredSdkKey("https://api2.cursor.sh", NOW, path)).toBeUndefined();
    writeFileSync(path, "not json");
    expect(await readStoredSdkKey("https://api2.cursor.sh", NOW, path)).toBeUndefined();
  });
});

describe("createUsage", () => {
  interface Call {
    url: string;
    auth: string;
  }

  function setup(handlers: Record<string, () => unknown | number>, opts: { secret?: string } = {}) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      calls.push({ url, auth: headers.get("authorization") ?? "" });
      const name = url.split("/").pop() ?? "";
      const produced = handlers[name]?.();
      if (typeof produced === "number") return new Response("no", { status: produced });
      return new Response(JSON.stringify(produced ?? {}), { status: 200 });
    }) as typeof fetch;
    const { ctx, logs } = fakeCtx({}, fakeSdk(() => say("x")).deps, {
      secrets: opts.secret === undefined ? { cursor_api_key: "test-key" } : { cursor_api_key: opts.secret },
    });
    let t = NOW;
    const service = createUsage(ctx, {
      key: async () => (opts.secret === "" ? undefined : (opts.secret ?? "test-key")),
      now: () => t,
      fetch: fetchImpl,
      base: "https://api.test",
      storedKey: async () => undefined,
    });
    return {
      service,
      calls,
      logs,
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  const ok = () => {
    const body = premium();
    return {
      exchange_user_api_key: () => ({ accessToken: "tok", refreshToken: "ref" }),
      GetPlanInfo: () => body.plan,
      GetCurrentPeriodUsage: () => body.period,
      GetHardLimit: () => body.hard,
    };
  };
  const meters = (blocks: unknown) => JSON.stringify(blocks).match(/"type":"meter"/g)?.length ?? 0;

  test("exchanges the API key once, then reuses the reading for a minute", async () => {
    const { service, calls, advance } = setup(ok());
    expect(meters(await service.view())).toBe(1);
    expect(calls.map((c) => c.url.split("/").pop())).toEqual([
      "exchange_user_api_key",
      "GetCurrentPeriodUsage",
      "GetPlanInfo",
      "GetHardLimit",
    ]);
    expect(calls[0]?.auth).toBe("Bearer test-key");
    expect(calls[1]?.auth).toBe("Bearer tok");
    expect(calls.every((c) => c.url.startsWith("https://api.test/"))).toBe(true);
    const periods = () => calls.filter((c) => c.url.endsWith("GetCurrentPeriodUsage")).length;
    advance(59_000);
    await service.refresh();
    expect(periods()).toBe(1);
    advance(2_000);
    await service.refresh();
    // The access token is reused, so the second read is the three RPCs only.
    expect(periods()).toBe(2);
    expect(calls.filter((c) => c.url.endsWith("exchange_user_api_key"))).toHaveLength(1);
  });

  test("a 401 exchanges again and then reads", async () => {
    let hits = 0;
    const handlers = ok();
    const { service, calls } = setup({
      ...handlers,
      GetCurrentPeriodUsage: () => {
        hits += 1;
        return hits === 1 ? 401 : handlers.GetCurrentPeriodUsage();
      },
    });
    expect(meters(await service.view())).toBe(1);
    expect(calls.filter((c) => c.url.endsWith("exchange_user_api_key"))).toHaveLength(2);
  });

  test("a failed hard-limit call still shows included usage", async () => {
    const handlers = ok();
    const { service } = setup({ ...handlers, GetHardLimit: () => 500 });
    const blocks = await service.view();
    expect(meters(blocks)).toBe(1);
    expect(JSON.stringify(blocks)).toContain("On-demand limit unavailable");
  });

  test("no key does not call Cursor", async () => {
    const { service, calls } = setup(ok(), { secret: "" });
    expect(await service.view()).toMatchObject([
      { text: "Plan usage needs a Cursor API key or a Cursor login." },
      { type: "note" },
      { type: "action" },
    ]);
    expect(calls).toHaveLength(0);
  });

  test("concurrent views share one read", async () => {
    const { service, calls } = setup(ok());
    await Promise.all([service.view(), service.view(), service.view()]);
    expect(calls.filter((c) => c.url.endsWith("exchange_user_api_key"))).toHaveLength(1);
  });

  test("a manual refresh is throttled for ten seconds, then forces a read", async () => {
    const { service, calls, advance } = setup(ok());
    const periods = () => calls.filter((c) => c.url.endsWith("GetCurrentPeriodUsage")).length;
    await service.view();
    advance(5_000);
    await service.refresh(true);
    expect(periods()).toBe(1);
    advance(6_000);
    await service.refresh(true);
    expect(periods()).toBe(2);
  });

  test("a rejected key is shown, logged, and not retried on its own for five minutes", async () => {
    let fail = true;
    const handlers = ok();
    const { service, calls, logs, advance } = setup({
      ...handlers,
      exchange_user_api_key: () => (fail ? 401 : handlers.exchange_user_api_key()),
    });
    expect(await service.view()).toMatchObject([
      { text: "Could not read usage: Cursor API key was rejected", tone: "warning" },
      {},
    ]);
    expect(logs.some((l) => l.level === "warn" && l.msg === "cursor usage read failed")).toBe(true);
    advance(4 * 60_000);
    await service.view();
    expect(calls).toHaveLength(1);
    fail = false;
    advance(2 * 60_000);
    await service.view();
    await service.refresh();
    expect(meters(await service.view())).toBe(1);
  });
});
