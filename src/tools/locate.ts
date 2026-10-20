import type { Locator, Page } from "playwright";
import type { Where } from "../schemas/common.ts";

/** Turns a case's `where` into a Playwright locator. Used by the tool layer and by the oracle. */
export function locatorFor(page: Page, where: Where): Locator {
  if ("selector" in where) return page.locator(where.selector);
  // The case file carries the role as a plain string, so cast it to Playwright's role type.
  return page.getByRole(where.role as Parameters<Page["getByRole"]>[0], where.name === undefined ? {} : { name: where.name, exact: true });
}
