import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
const base = "http://127.0.0.1:8768";
test.describe.configure({ mode: "serial", timeout: 45000 });
async function access(request, origin = base) {
  return (
    await (
      await request.get(origin + "/api/session", {
        headers: { Origin: origin, "X-Kaira-Client": "v16" },
      })
    ).json()
  ).token;
}
async function status(request, token) {
  return (
    await request.get(base + "/api/status", {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
}
test.beforeEach(async ({ request }) => {
  const token = await access(request),
    s = await status(request, token);
  if (s.run)
    await request.post(base + "/api/pause", {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        request_id: crypto.randomUUID(),
        expected_run: s.run,
        expected_revision: s.revision,
      },
    });
});
async function open(page) {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(base + "/market.html");
  await expect(page.locator("#connection-state")).toHaveText(
    "Connected to market service",
  );
}
test("fixture monitoring uses the Python ledger and preserves state across reload and pause", async ({
  page,
}) => {
  await open(page);
  await expect(page.locator("#source-badge")).toContainText("OFFLINE FIXTURE");
  await page.locator("#start").click();
  await expect(page.locator("#decisions tr")).toHaveCount(4, {
    timeout: 40000,
  });
  await expect(page.locator("#accounts article")).toHaveCount(4);
  await expect(page.locator("#quotes tr")).toHaveCount(2);
  await expect(page.locator("#decisions")).toContainText("SIMULATED FILL");
  const balances = await page.locator("#accounts").textContent();
  await page.reload();
  await expect(page.locator("#accounts")).toHaveText(balances);
  await page.locator("#pause").click();
  await expect(page.locator("#run-state")).toHaveText("PAUSED");
  await page.reload();
  await expect(page.locator("#run-state")).toHaveText("PAUSED");
  await expect(page.locator("#decisions tr")).toHaveCount(4);
  const download = page.waitForEvent("download");
  await page.locator("#export").click();
  const state = JSON.parse(
    (await readFile(await (await download).path())).toString(),
  );
  expect(state.mode).toBe("fixture");
  expect(state.events[0].market_evidence.bars).toHaveLength(2);
  expect(state).not.toHaveProperty("token");
});
test("uncertain start response retries the same run ID without resetting its accounts", async ({
  page,
  request,
}) => {
  await open(page);
  let first = true,
    run;
  await page.route("**/api/start", async (route) => {
    if (first) {
      first = false;
      run = (await (await route.fetch()).json()).run;
      await route.abort("connectionreset");
    } else await route.continue();
  });
  await page.locator("#start").click();
  await expect(page.locator("#retry")).toBeVisible();
  await page.locator("#retry").click();
  await expect(page.locator("#retry")).toBeHidden();
  expect((await status(request, await access(request))).run).toBe(run);
  await page.locator("#pause").click();
});
test("connection failure disables monitoring controls and preserves a stale view", async ({
  page,
}) => {
  await open(page);
  await page.route("**/api/status", (route) => route.abort());
  await page.locator("#refresh").click();
  await expect(page.locator("#connection-state")).toContainText("stale");
  await expect(page.locator("#start")).toBeDisabled();
  await expect(page.locator("#resume")).toBeDisabled();
  await page.unroute("**/api/status");
  await page.locator("#refresh").click();
  await expect(page.locator("#start")).toBeEnabled();
});
test("live source is visibly blocked and cannot be activated through the browser", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:8769/market.html");
  await expect(page.locator("#connection-state")).toHaveText(
    "Connected to market service",
  );
  await expect(page.locator("#policy-block")).toContainText("V8/V10");
  await expect(page.locator("#health-state")).toHaveText("BLOCKED");
  await expect(page.locator("#source-badge")).toHaveText("LIVE FEED BLOCKED");
  await expect(page.locator("#start")).toBeDisabled();
  await expect(page.locator("#quotes tr")).toHaveCount(0);
  await expect(page.locator("#decisions tr")).toHaveCount(0);
});
test("Pages pairs with the real V16 API and the dark mobile layout fits", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["local-network-access"], {
    origin: "https://anttitulenheimo.github.io",
  });
  await context.route(
    "https://anttitulenheimo.github.io/KairaTrading/**",
    async (route) => {
      const file =
        new URL(route.request().url()).pathname.split("/").at(-1) ||
        "market.html";
      await route.fulfill({
        body: await readFile(path.resolve("public", file)),
        contentType: {
          ".html": "text/html",
          ".mjs": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
        }[path.extname(file)],
      });
    },
  );
  await page.goto("https://anttitulenheimo.github.io/KairaTrading/market.html");
  await page.locator("#service-url").fill(base);
  const waiting = page.waitForEvent("popup");
  await page.locator("#connect").click();
  const popup = await waiting;
  await expect(popup.locator("#connect")).toHaveText(
    "Confirm Pages connection",
  );
  await popup.locator("#connect").click();
  await expect(page.locator("#connection-state")).toHaveText(
    "Connected to market service",
  );
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    ),
  ).toBe("dark");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/v16-mobile.png",
    fullPage: true,
  });
});
