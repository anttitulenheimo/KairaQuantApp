import { test, expect } from "@playwright/test";
const journal = "kaira.v14.journal",
  broker = "kaira.v14.broker";
async function start(page, profile = "normal") {
  await page.goto("/execution.html");
  await page.locator("#exec-profile").selectOption(profile);
  await page.locator("#exec-start").click();
  await expect(page.locator("#exec-step")).toBeEnabled();
}
test("planned, sent, partial and filled are visible separately and survive reload", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await start(page, "partial");
  await page.locator("#exec-step").click();
  await expect(page.locator("#exec-stage")).toHaveText("Decision saved");
  await page.locator("#exec-step").click();
  await expect(page.locator("#exec-stage")).toHaveText("Submitted");
  await expect(page.locator("#exec-fill-count")).toHaveText("0");
  await page.locator("#exec-step").click();
  await expect(page.locator("#exec-stage")).toHaveText("Partially filled");
  const cash = await page.locator("#exec-cash").textContent();
  await page.reload();
  await expect(page.locator("#exec-cash")).toHaveText(cash);
  await page.locator("#exec-step").click();
  await expect(page.locator("#exec-stage")).toHaveText("Filled");
  await expect(page.locator("#exec-fill-count")).toHaveText("2");
  await expect(page.locator("#exec-count")).toHaveText("1 / 13");
  expect(errors).toEqual([]);
});
test("lost acceptance acknowledgement reloads and reconciles one broker ID", async ({
  page,
}) => {
  await start(page, "faults");
  await page.locator("#exec-year").click();
  await expect(page.locator("#exec-notice")).toContainText("acknowledgement was lost");
  const ids = await page.evaluate(
    (k) => Object.keys(JSON.parse(localStorage.getItem(k)).orders),
    broker,
  );
  expect(ids).toHaveLength(1);
  await page.reload();
  await page.locator("#exec-step").click();
  await expect(page.locator("#exec-stage")).toHaveText("Submitted");
  expect(
    await page.evaluate(
      (k) => Object.keys(JSON.parse(localStorage.getItem(k)).orders),
      broker,
    ),
  ).toEqual(ids);
  await page.locator("#exec-step").click();
  await expect(page.locator("#exec-fill-count")).toHaveText("1");
});
test("normal ETH stress year completes, exports ledger, and preserves V13 session", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#next").click();
  const old = await page.evaluate(() =>
    localStorage.getItem("kaira.v13.session"),
  );
  await page.goto("/execution.html");
  await page.locator("#exec-asset").selectOption("ETH");
  await page.locator("#exec-cost").selectOption("stress");
  await page.locator("#exec-start").click();
  await page.locator("#exec-year").click();
  await expect(page.locator("#exec-stage")).toHaveText("TEST YEAR COMPLETE");
  await expect(page.locator("#exec-count")).toHaveText("13 / 13");
  await expect(page.locator("#exec-quantity")).toContainText("ETH");
  await expect(page.locator("#exec-reserve")).toContainText("Terminal reserve");
  await expect(page.locator("#exec-step")).toBeDisabled();
  expect(
    await page.evaluate(() => localStorage.getItem("kaira.v13.session")),
  ).toBe(old);
  const download = page.waitForEvent("download");
  await page.locator("#exec-export").click();
  expect((await download).suggestedFilename()).toContain("kaira-v14-ETH");
});
test("simultaneous tabs serialize transitions rather than duplicate orders", async ({
  page,
  context,
}) => {
  await start(page);
  const other = await context.newPage();
  await other.goto("/execution.html");
  await Promise.all([
    page.locator("#exec-step").click(),
    other.locator("#exec-step").click(),
  ]);
  await expect(page.locator("#exec-stage")).toHaveText("Submitted");
  await expect(other.locator("#exec-stage")).toHaveText("Submitted");
  expect(
    await page.evaluate(
      (k) => Object.keys(JSON.parse(localStorage.getItem(k)).orders).length,
      broker,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(
      (k) => JSON.parse(localStorage.getItem(k)).orders.length,
      journal,
    ),
  ).toBe(1);
});
test("broker result persists across a failed journal acknowledgement", async ({
  page,
}) => {
  await start(page);
  await page.locator("#exec-step").click();
  await page.locator("#exec-step").click();
  await page.evaluate((k) => {
    const original = Storage.prototype.setItem;
    let failed = false;
    Storage.prototype.setItem = function (key, value) {
      if (key === k && !failed) {
        failed = true;
        throw Error("Test quota");
      }
      return original.call(this, key, value);
    };
  }, journal);
  await page.locator("#exec-step").click();
  await expect(page.locator("#exec-notice")).toContainText("Execution stopped");
  await expect(page.locator("#exec-fill-count")).toHaveText("0");
  await page.reload();
  await page.locator("#exec-step").click();
  await expect(page.locator("#exec-fill-count")).toHaveText("1");
  await expect(page.locator("#exec-stage")).toHaveText("Filled");
});
test("missing broker data blocks continuation without erasing the journal", async ({
  page,
}) => {
  await start(page);
  await page.locator("#exec-step").click();
  await expect(page.locator("#exec-stage")).toHaveText("Decision saved");
  const original = await page.evaluate((k) => localStorage.getItem(k), journal);
  await page.evaluate((k) => localStorage.removeItem(k), broker);
  await page.reload();
  await expect(page.locator("#exec-step")).toBeDisabled();
  await expect(page.locator("#exec-notice")).toContainText(
    "Cannot resume stored state",
  );
  expect(await page.evaluate((k) => localStorage.getItem(k), journal)).toBe(
    original,
  );
});
test("mobile fault run can resume to completion without external calls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const external = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("http://127.0.0.1:4173/")) external.push(r.url());
  });
  await start(page, "faults");
  // Three lost acknowledgements (indices 0, 5, 10), each explicitly resumed.
  for (let i = 0; i < 4; i++) {
    await page.locator("#exec-year").click();
    await expect(page.locator("#exec-stop")).toBeHidden();
  }
  await expect(page.locator("#exec-stage")).toHaveText("TEST YEAR COMPLETE");
  await expect(page.locator("#exec-orders")).toContainText("Rejected");
  await expect(page.locator("#exec-orders")).toContainText("Remainder canceled");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(external).toEqual([]);
  await page.screenshot({
    path: "test-results/v14-mobile.png",
    fullPage: true,
  });
});
test("desktop execution view renders complete ledger", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  await start(page, "partial");
  await page.locator("#exec-year").click();
  await expect(page.locator("#exec-stage")).toHaveText("TEST YEAR COMPLETE");
  await page.screenshot({
    path: "test-results/v14-desktop.png",
    fullPage: true,
  });
});
