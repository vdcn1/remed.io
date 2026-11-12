import { expect, test, type Page, type Request } from "@playwright/test";

// Drug search: the autocomplete on the two remedy fields.

const FIRST_REMEDY = "First remedy";
const SECOND_REMEDY = "Second remedy";

function remedyField(page: Page, fieldName: string) {
  return page.getByRole("combobox", { name: fieldName });
}

/** Types into a field and waits for the suggestion request it triggers. */
async function typeAndWaitForSuggestions(page: Page, fieldName: string, text: string) {
  const suggestionResponse = page.waitForResponse((response) => response.url().includes("/api/drugs?q="));
  await remedyField(page, fieldName).fill(text);
  await suggestionResponse;
}

function collectRequests(page: Page, urlPart: string) {
  const requests: Request[] = [];
  page.on("request", (request) => {
    if (request.url().includes(urlPart)) requests.push(request);
  });
  return requests;
}

test.describe("drug search", () => {
  test("suggests drugs that contain the typed text", async ({ page }) => {
    await page.goto("/");
    await typeAndWaitForSuggestions(page, FIRST_REMEDY, "war");

    const suggestions = page.getByRole("listbox");
    await expect(suggestions).toBeVisible();
    await expect(suggestions.getByRole("option", { name: /Warfarin/ })).toBeVisible();
  });

  test("matches brand names and shows which brand matched", async ({ page }) => {
    await page.goto("/");
    await typeAndWaitForSuggestions(page, FIRST_REMEDY, "advil");

    const ibuprofenOption = page.getByRole("option", { name: /Ibuprofen/ });
    await expect(ibuprofenOption).toBeVisible();
    await expect(ibuprofenOption).toContainText("Advil");
  });

  test("each suggestion shows its kind as a tag with its own colour class", async ({ page }) => {
    await page.goto("/");
    await typeAndWaitForSuggestions(page, FIRST_REMEDY, "war");

    await expect(page.getByRole("option", { name: /Warfarin/ }).locator(".tag-drug")).toHaveText("drug");
  });

  test("picking a suggestion with the keyboard fills the field and closes the list", async ({ page }) => {
    await page.goto("/");
    const field = remedyField(page, FIRST_REMEDY);
    await typeAndWaitForSuggestions(page, FIRST_REMEDY, "war");

    await field.press("ArrowDown");
    await expect(page.getByRole("option", { name: /Warfarin/ })).toHaveAttribute("aria-selected", "true");
    await field.press("Enter");

    await expect(field).toHaveValue("Warfarin");
    await expect(page.getByRole("listbox")).toHaveCount(0);
  });

  test("picking a suggestion with the mouse fills the field", async ({ page }) => {
    await page.goto("/");
    await typeAndWaitForSuggestions(page, SECOND_REMEDY, "warf");

    await page.getByRole("option", { name: /Warfarin/ }).click();

    await expect(remedyField(page, SECOND_REMEDY)).toHaveValue("Warfarin");
    await expect(page.getByRole("listbox")).toHaveCount(0);
  });

  test("shows no suggestions for text that matches nothing", async ({ page }) => {
    await page.goto("/");
    await typeAndWaitForSuggestions(page, FIRST_REMEDY, "zzqxvnotadrug");

    await expect(page.getByRole("listbox")).toHaveCount(0);
  });

  test("an empty field sends no search request and shows no suggestions", async ({ page }) => {
    const searchRequests = collectRequests(page, "/api/drugs");
    await page.goto("/");
    await remedyField(page, FIRST_REMEDY).focus();
    // Give a debounced search time to fire if it was going to.
    await page.waitForTimeout(400);

    expect(searchRequests).toHaveLength(0);
    await expect(page.getByRole("listbox")).toHaveCount(0);
  });

  test("clearing the field removes the suggestions", async ({ page }) => {
    await page.goto("/");
    await typeAndWaitForSuggestions(page, FIRST_REMEDY, "war");
    await expect(page.getByRole("listbox")).toBeVisible();

    await remedyField(page, FIRST_REMEDY).fill("");

    await expect(page.getByRole("listbox")).toHaveCount(0);
  });

  test("the two fields search independently", async ({ page }) => {
    await page.goto("/");
    await typeAndWaitForSuggestions(page, SECOND_REMEDY, "advil");

    await expect(page.getByRole("option", { name: /Ibuprofen/ })).toBeVisible();
    await expect(remedyField(page, FIRST_REMEDY)).toHaveValue("");
  });
});

test.describe("both remedy fields empty", () => {
  test("the Check button is disabled when both fields are empty", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("button", { name: "Check", exact: true })).toBeDisabled();
  });

  test("the Check button stays disabled when only the first field is filled", async ({ page }) => {
    await page.goto("/");
    await remedyField(page, FIRST_REMEDY).fill("Warfarin");

    await expect(page.getByRole("button", { name: "Check", exact: true })).toBeDisabled();
  });

  test("the Check button stays disabled when both fields hold only spaces", async ({ page }) => {
    await page.goto("/");
    await remedyField(page, FIRST_REMEDY).fill("   ");
    await remedyField(page, SECOND_REMEDY).fill("   ");

    await expect(page.getByRole("button", { name: "Check", exact: true })).toBeDisabled();
  });

  test("the Check button is enabled once both fields have a name", async ({ page }) => {
    await page.goto("/");
    await remedyField(page, FIRST_REMEDY).fill("Warfarin");
    await remedyField(page, SECOND_REMEDY).fill("Advil");

    await expect(page.getByRole("button", { name: "Check", exact: true })).toBeEnabled();
  });

  test("pressing Enter with both fields empty sends no request and shows no result", async ({ page }) => {
    const checkRequests = collectRequests(page, "/api/interactions");
    await page.goto("/");
    await remedyField(page, FIRST_REMEDY).press("Enter");
    await page.waitForTimeout(300);

    expect(checkRequests).toHaveLength(0);
    await expect(page.locator(".result")).toHaveCount(0);
    await expect(page.locator(".alert")).toHaveCount(0);
  });

  test("the API rejects a check with both names empty", async ({ request }) => {
    const response = await request.post("/api/interactions", {
      data: { first: "", second: "" },
    });

    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({ error: "Provide two remedies: { first, second }" });
  });
});
