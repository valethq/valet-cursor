import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CORE = process.env.VALET_CORE_DIR ?? join(import.meta.dir, "..", "..", "valet-core");
const CLI = join(CORE, "packages/core/src/cli.ts");
const ROOT = join(import.meta.dir, "..");
let proc: Bun.Subprocess | undefined;
afterAll(() => proc?.kill("SIGKILL"));

test("the real kernel loads the plugin and activates it", async () => {
  const home = mkdtempSync(join(tmpdir(), "valet-cursor-"));
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = server.port as number;
  await server.stop(true);
  const own = join(home, "plugins", "valet-cursor");
  mkdirSync(own, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  writeFileSync(join(own, "manifest.json"), JSON.stringify({ ...manifest, main: "./index.ts" }));
  writeFileSync(
    join(own, "index.ts"),
    `export { default } from ${JSON.stringify(join(ROOT, "src", "index.ts"))};\n`,
  );
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      server: { port },
      pluginPaths: [join(home, "plugins")],
      plugins: { "valet-cursor": { config: { denyTools: ["shell"], mode: "agent" } } },
    }),
  );
  proc = Bun.spawn(["bun", CLI, "start", "--home", home], {
    stdout: Bun.file(join(home, "out.log")),
    stderr: Bun.file(join(home, "err.log")),
  });
  const end = Date.now() + 15_000;
  let status: unknown;
  while (Date.now() < end && !status) {
    status = await fetch(`http://127.0.0.1:${port}/`).then(
      (r) => (r.status === 200 ? r.json() : undefined),
      () => undefined,
    );
    if (!status) await Bun.sleep(50);
  }
  const log = `${readFileSync(join(home, "out.log"), "utf8")}${readFileSync(join(home, "err.log"), "utf8")}`;
  expect(status, log).toBeDefined();
  expect(JSON.stringify(status)).toContain("valet-cursor");
  expect(log).toContain("1 plugins active, 0 failed");
}, 30_000);
