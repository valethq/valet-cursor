import { definePlugin } from "@valethq/sdk";
import type { CursorConfig } from "./config";
import { createCatalog } from "./models";
import { createProvider, PROVIDER_KEY } from "./provider";
import { realSdk } from "./sdk";
import { apiKey, registerSettings } from "./settings";

export default definePlugin<CursorConfig>({
  activate(ctx) {
    const catalog = createCatalog(
      async () => {
        const key = await apiKey(ctx);
        if (key) return realSdk.listModels({ apiKey: key });
        return (await realSdk.authStatus()).status === "logged-in" ? realSdk.listModels() : undefined;
      },
      (e) => ctx.log.warn("cursor model catalog unavailable, using the built-in list", { error: e.message }),
    );
    const { provider, dispose } = createProvider(ctx, catalog);
    ctx.onDispose(dispose);
    ctx.scopes.provide("inference", provider, { key: PROVIDER_KEY });
    registerSettings(ctx, realSdk, catalog);
  },
});
