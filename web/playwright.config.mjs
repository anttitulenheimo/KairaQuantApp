import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.browser.mjs",
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  webServer: [
    {
      command:
        "python3 ../run_v16_service.py --source fixture --port 8768 --db ../.runtime/v16-playwright/fixture.sqlite3 --interval 0.05",
      url: "http://127.0.0.1:8768/market.html",
      reuseExistingServer: !process.env.CI,
    },
    {
      command:
        "python3 ../run_v16_service.py --port 8769 --db ../.runtime/v16-playwright/blocked.sqlite3 --interval 0.05",
      url: "http://127.0.0.1:8769/market.html",
      reuseExistingServer: !process.env.CI,
    },
    {
      command:
        "python3 -m http.server 4173 --directory public --bind 127.0.0.1",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
    },
    {
      command:
        "python3 ../run_v15_service.py --port 8766 --db ../.runtime/v15-playwright/service.sqlite3 --interval 0.05",
      url: "http://127.0.0.1:8766/service.html",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
