// Drives Sirna in Edge like a user: the main window, the capture bar and the
// focus sheet as pages of one browser context, sharing one database through
// the dev harness (src/dev/tauriPreview.ts). See README.md in this folder.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Screenshots go here (git-ignored). */
export const OUT_DIR = path.resolve(HERE, "../../user-test-out");

/** Today's date in Addis Ababa, "2026-11-24" (calendar date, not the 03:00 logical day). */
export function addisToday() {
  return new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Starts Edge (the installed one: no browser download) with one context.
 * Needs the dev server: `pnpm --dir apps/desktop dev` (http://localhost:1420).
 */
export async function launch({
  baseUrl = process.env.SIRNA_URL ?? "http://localhost:1420",
  headless = true,
  viewport = { width: 1040, height: 720 },
} = {}) {
  const browser = await chromium.launch({ channel: "msedge", headless });
  const context = await browser.newContext({ viewport });
  return new Sirna(browser, context, baseUrl);
}

export class Sirna {
  /** @type {{ page: string, type: string, text: string }[]} */
  errors = [];
  /** @type {import("playwright-core").Page | undefined} */
  main;

  constructor(browser, context, baseUrl) {
    this.browser = browser;
    this.context = context;
    this.baseUrl = baseUrl;
  }

  /** Opens a page of the app and waits until the harness is installed. */
  async open(file, params = {}, { size } = {}) {
    const page = await this.context.newPage();
    if (size) await page.setViewportSize(size);
    const name = file.replace(/\.html$/, "");
    page.on("console", (message) => {
      // The dev server has no favicon; that 404 is noise.
      if (message.type() === "error" && !message.location()?.url?.endsWith("/favicon.ico")) {
        const where = message.location()?.url;
        this.errors.push({
          page: name,
          type: "console",
          text: `${message.text()}${where ? ` (${where})` : ""}`,
        });
      }
    });
    page.on("pageerror", (error) =>
      this.errors.push({ page: name, type: "pageerror", text: String(error) }),
    );
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null));
    await page.goto(`${this.baseUrl}/${file}${query.size ? `?${query}` : ""}`);
    await page.waitForFunction(() => globalThis.__sirna !== undefined, null, { timeout: 30_000 });
    return page;
  }

  /**
   * The main window. `now` is Addis time ("2026-11-24T09:30"); it is held
   * still and shared by every page until `advance` moves it. `fresh` starts
   * again from dev-data/sirna.db. `screen` is what take_screen returns.
   */
  async openMain({ now, fresh = false, screen } = {}) {
    if (this.main && !this.main.isClosed()) await this.main.close();
    this.main = await this.open("index.html", { now, fresh: fresh ? "1" : undefined, screen });
    await this.main
      .waitForSelector("main, [role=main], h1", { timeout: 30_000 })
      .catch(() => undefined);
    return this.main;
  }

  /** Any page that has the harness, for reads and the clock. */
  async anyPage() {
    const open = this.context.pages().filter((page) => !page.isClosed());
    return open[0] ?? (await this.open("index.html"));
  }

  /** Every window event so far (open_capture, focus_setup_open, close_window…). */
  async windowLog() {
    return (await this.anyPage()).evaluate(() => globalThis.__sirna.windowLog);
  }

  async #waitForWindowEvent(command, page, after, timeout = 15_000) {
    const reader = await this.anyPage();
    await reader.waitForFunction(
      ({ command, page, after }) =>
        globalThis.__sirna.windowLog
          .slice(after)
          .some((e) => e.command === command && e.page === page),
      { command, page, after },
      { timeout },
    );
  }

  /**
   * Opens the capture bar (as the hotkey would), types `text`, presses Enter
   * and waits until the bar closes itself. Returns the echo it showed.
   */
  async capture(text, { keepOpen = false } = {}) {
    const before = (await this.windowLog()).length;
    const page = await this.open("capture.html", {}, { size: { width: 680, height: 52 } });
    const input = page.locator("#capture-input");
    await input.click();
    await input.fill(text);
    const chip = await page.locator("#capture-echo").textContent();
    await input.press("Enter");
    await this.#waitForWindowEvent("close_window", "capture.html", before);
    const echo = await page.locator("#capture-echo").textContent();
    if (!keepOpen) await page.close();
    return { chip, echo, page: keepOpen ? page : undefined };
  }

  /**
   * The focus set-up sheet. With `fromToday` (default) it clicks "Start focus"
   * on Today's Now card, which asks for the sheet; then it opens setup.html
   * the way Rust opens the window.
   */
  async openFocusSheet({ fromToday = true } = {}) {
    const before = (await this.windowLog()).length;
    if (fromToday) {
      if (!this.main) throw new Error("openMain first");
      await this.main.getByRole("button", { name: "Start focus" }).first().click();
      await this.#waitForWindowEvent("focus_setup_open", "setup.html", before);
    }
    const sheet = await this.open("setup.html", {}, { size: { width: 480, height: 360 } });
    await sheet.waitForFunction(
      () =>
        document.querySelector("#setup-title")?.textContent !== "Focus" ||
        document.querySelector("#setup-for option"),
    );
    return sheet;
  }

  /** Types the intent and presses Enter on the sheet; resolves with the sheet's message, if any. */
  async startFocus(sheet, { intent } = {}) {
    const before = (await this.windowLog()).length;
    if (intent !== undefined) await sheet.locator("#setup-intent").fill(intent);
    await sheet.locator("#setup-intent").press("Enter");
    const closed = await this.#waitForWindowEvent("close_window", "setup.html", before, 5_000)
      .then(() => true)
      .catch(() => false);
    const message = closed ? "" : await sheet.locator("#setup-message").textContent();
    if (closed) await sheet.close();
    return { started: closed, message };
  }

  /** Moves the shared clock; the focus timer ticks on the way. Reloads the open pages so they show it. */
  async advance(minutes, { reload = true } = {}) {
    const page = await this.anyPage();
    const at = await page.evaluate((m) => globalThis.__sirna.advance(m), minutes);
    if (reload)
      for (const open of this.context.pages()) {
        await open.reload();
        await open.waitForFunction(() => globalThis.__sirna !== undefined);
      }
    return at;
  }

  async now() {
    return (await this.anyPage()).evaluate(() => globalThis.__sirna.nowText());
  }

  /** A read query against the shared database. */
  async query(sql, params = []) {
    return (await this.anyPage()).evaluate(
      ([sql, params]) => globalThis.__sirna.query(sql, params),
      [sql, params],
    );
  }

  /** Saves a full-page screenshot to user-test-out/<name>.png and returns its path. */
  async screenshot(page, name) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  }

  /** Console errors and uncaught exceptions from every page so far. */
  consoleErrors() {
    return [...this.errors];
  }

  async close() {
    await this.browser.close();
  }
}
