import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
const base = "http://127.0.0.1:8766";
test.describe.configure({ mode: "serial" });
async function access(request) {
  const response = await request.get(base + "/api/session", {
    headers: { Origin: base, "X-Kaira-Client": "v15" },
  });
  return (await response.json()).token;
}
async function status(request, token) {
  return (
    await request.get(base + "/api/status", {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
}
test.beforeEach(async ({ request }) => {
  const token = await access(request);
  let s = await status(request, token);
  if (s.run) {
    await request.post(base + "/api/pause", {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        request_id: crypto.randomUUID(),
        expected_run: s.run,
        expected_revision: s.revision,
      },
    });
  }
});
async function open(page, profile = "normal") {
  page.on("dialog", (d) => d.accept());
  await page.goto(base + "/service.html");
  await expect(page.locator("#service-state")).toHaveText(
    "Connected to Python service",
  );
  await page.locator("#exec-profile").selectOption(profile);
  await page.locator("#exec-asset").selectOption("ETH");
  await page.locator("#exec-start").click();
  await expect(page.locator("#exec-step")).toBeEnabled();
}
test("browser controls Python; server completes after browser is closed", async ({
  page,
  context,
  request,
}) => {
  await open(page);
  await page.locator("#exec-year").click();
  await page.close();
  const token = await access(request);
  await expect
    .poll(async () => (await status(request, token)).view.complete)
    .toBe(true);
  const restored = await context.newPage();
  await restored.goto(base + "/service.html");
  await expect(restored.locator("#exec-stage")).toHaveText("TEST YEAR COMPLETE");
  await expect(restored.locator("#exec-fill-count")).toHaveText("13");
});
test("Python partial fill and lost acknowledgement remain on reload", async ({
  page,
}) => {
  await open(page, "partial");
  for (let i = 0; i < 3; i++) {
    await page.locator("#exec-step").click();
    await expect(page.locator("#exec-step")).toBeEnabled();
  }
  await expect(page.locator("#exec-stage")).toHaveText("Partially filled");
  const cash = await page.locator("#exec-cash").textContent();
  await page.reload();
  await expect(page.locator("#exec-cash")).toHaveText(cash);
  await expect(page.locator("#exec-save")).toContainText("Active run: ETH");
  await page.locator("#exec-step").click();
  await expect(page.locator("#exec-fill-count")).toHaveText("2");
  await page.locator("#exec-profile").selectOption("faults");
  await page.locator("#exec-start").click();
  await page.locator("#exec-year").click();
  await expect(page.locator("#exec-reason")).toContainText("acknowledgement was lost");
  await page.reload();
  await page.locator("#exec-step").click();
  await expect(page.locator("#exec-stage")).toHaveText("Submitted");
  await expect(page.locator("#exec-count")).toHaveText("1 / 13");
});
test("response lost after commit retries the identical HTTP command once", async ({
  page,
}) => {
  await open(page);
  let intercepted = false;
  await page.route("**/api/step", async (route) => {
    if (!intercepted) {
      intercepted = true;
      await route.fetch();
      await route.abort("connectionreset");
    } else await route.continue();
  });
  await page.locator("#exec-step").click();
  await expect(page.locator("#service-retry")).toBeVisible();
  await page.locator("#service-retry").click();
  await expect(page.locator("#exec-count")).toHaveText("1 / 13");
  await expect(page.locator("#exec-stage")).toHaveText("Decision saved");
});
test("disconnection marks values stale and prevents commands until refresh", async ({
  page,
}) => {
  await open(page);
  await page.route("**/api/status", (route) => route.abort());
  await page.locator("#service-refresh").click();
  await expect(page.locator("#service-state")).toContainText("stale");
  await expect(page.locator("#exec-step")).toBeDisabled();
  await page.unroute("**/api/status");
  await page.locator("#service-refresh").click();
  await expect(page.locator("#exec-step")).toBeEnabled();
});
test("Pages origin pairs with real loopback API; no simulated frontend fallback", async ({
  page,
  context,
}) => {
  // Only static Pages assets are intercepted; all API traffic hits the Python process.
  // Represent the user's browser permission; keep CORS and network checks enabled.
  await context.grantPermissions(["local-network-access"], {
    origin: "https://anttitulenheimo.github.io",
  });
  await context.route(
    "https://anttitulenheimo.github.io/KairaTrading/**",
    async (route) => {
      const name =
        new URL(route.request().url()).pathname.split("/").at(-1) ||
        "service.html";
      const types = {
        ".html": "text/html",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
      };
      await route.fulfill({
        body: await readFile(path.resolve("public", name)),
        contentType: types[path.extname(name)],
      });
    },
  );
  await page.goto(
    "https://anttitulenheimo.github.io/KairaTrading/service.html",
  );
  await page.locator("#service-url").fill(base);
  const popupPromise = page.waitForEvent("popup");
  await page.locator("#service-connect").click();
  const popup = await popupPromise;
  await expect(popup.locator("#service-connect")).toHaveText(
    "Confirm Pages connection",
  );
  await popup.locator("#service-connect").click();
  await expect(page.locator("#service-state")).toHaveText(
    "Connected to Python service",
  );
  page.on("dialog", (d) => d.accept());
  await page.locator("#exec-start").click();
  await page.locator("#exec-step").click();
  await expect(page.locator("#exec-count")).toHaveText("1 / 13");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/v15-mobile.png",
    fullPage: true,
  });
});
