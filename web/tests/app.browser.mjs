import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const key = "kaira.v13.session";
test("whole-year flow, both accounts, costs, restart, JSON export and import", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  await expect(page.locator("#events tr")).toHaveCount(1);
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(page.locator("#clock")).toContainText("2/1/2020");
  await expect(page.locator("#events tr")).toHaveCount(2);
  const before = await page.locator("#equity").textContent();
  await page.reload();
  await expect(page.locator("#equity")).toHaveText(before);
  await expect(page.locator("#events tr")).toHaveCount(2);
  await page.getByRole("button", { name: "Run full year" }).click();
  await expect(page.locator("#events tr")).toHaveCount(13);
  await expect(page.locator("#next")).toBeDisabled();
  await expect(page.locator("#next-decision")).toContainText(
    "Test year complete",
  );
  await page.getByRole("button", { name: "ETH Ethereum" }).click();
  await expect(page.locator("#quantity")).toContainText("ETH");
  await page.locator("#cost").selectOption("stress");
  const finalEquity = await page.locator("#equity").textContent();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const download = await downloadPromise;
  const exported = await readFile(await download.path());
  await page.getByRole("button", { name: "Reset simulation" }).click();
  await expect(page.locator("#events tr")).toHaveCount(1);
  await page
    .locator("#import-file")
    .setInputFiles({
      name: "session.json",
      mimeType: "application/json",
      buffer: exported,
    });
  await expect(page.locator("#equity")).toHaveText(finalEquity);
  await expect(page.locator("#events tr")).toHaveCount(13);
  expect(errors).toEqual([]);
});
test("invalid imports cannot alter current balances", async ({ page }) => {
  await page.goto("/");
  await page.locator("#next").click();
  const equity = await page.locator("#equity").textContent();
  await page
    .locator("#import-file")
    .setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"step":-100}'),
    });
  await expect(page.locator("#notice")).toContainText("Import rejected");
  await expect(page.locator("#equity")).toHaveText(equity);
  await expect(page.locator("#events tr")).toHaveCount(2);
});
test("corrupt saved state stays intact until explicit reset", async ({
  page,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  await page.evaluate((key) => localStorage.setItem(key, "broken"), key);
  await page.reload();
  await expect(page.locator("#next")).toBeDisabled();
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
    "broken",
  );
  await page.locator("#reset").click();
  await expect(page.locator("#next")).toBeEnabled();
  await expect(page.locator("#notice")).toBeHidden();
});
test("a second tab detects changes and cannot overwrite progress", async ({
  page,
  context,
}) => {
  await page.goto("/");
  const other = await context.newPage();
  await other.goto("/");
  await page.locator("#next").click();
  await expect(other.locator("#notice")).toContainText("another tab");
  await expect(other.locator("#next")).toBeDisabled();
  await other.reload();
  await expect(other.locator("#events tr")).toHaveCount(2);
});
test("quota failure does not advance clock or balances", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw Error("QuotaExceededError");
    };
  });
  await page.locator("#next").click();
  await expect(page.locator("#notice")).toContainText(
    "Save failed",
  );
  await expect(page.locator("#clock")).toContainText("1/14/2020");
  await expect(page.locator("#events tr")).toHaveCount(1);
});
test("all scenarios work on mobile without horizontal page overflow or external requests", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://127.0.0.1:4173/")) requests.push(r.url());
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  for (const scenario of ["waves", "trend", "shock"]) {
    await page.locator("#scenario").selectOption(scenario);
    await page.locator("#finish").click();
    await expect(page.locator("#events tr")).toHaveCount(13);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  expect(requests).toEqual([]);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
});
test("desktop renders chart and synthetic context", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto("/");
  await page.locator("#finish").click();
  await expect(
    page.getByRole("heading", { name: "One month at a time." }),
  ).toBeVisible();
  await expect(page.locator("#chart path.chart-monthly")).toBeAttached();
  await page.screenshot({ path: "test-results/desktop.png", fullPage: true });
});
