import { strict as assert } from "assert";
import { JSDOM } from "jsdom";
import {
  findMissingCredentials,
  renderUnconfiguredProvider,
} from "../src/oauthProvisioning";

describe("OAuth provisioning: missing credentials", () => {
  it("reports nothing when every credential has a value", () => {
    const missing = findMissingCredentials({
      BOX_CLIENT_ID: "abc123",
      BOX_CLIENT_SECRET: "shhh",
    });
    assert.deepEqual(missing, []);
  });

  it("names the credential a build left empty", () => {
    // This is the OneDrive case: the app was never registered, so DefinePlugin
    // substitutes "" and the provider answers AADSTS900144 instead.
    const missing = findMissingCredentials({ ONEDRIVE_CLIENT_ID: "" });
    assert.deepEqual(missing, ["ONEDRIVE_CLIENT_ID"]);
  });

  it("names every missing credential, not just the first", () => {
    const missing = findMissingCredentials({
      KOOFR_CLIENT_ID: "",
      KOOFR_CLIENT_SECRET: "",
    });
    assert.deepEqual(missing, ["KOOFR_CLIENT_ID", "KOOFR_CLIENT_SECRET"]);
  });

  it("treats whitespace and undefined as missing", () => {
    const missing = findMissingCredentials({
      A: "   ",
      B: undefined,
      C: "real",
    });
    assert.deepEqual(missing, ["A", "B"]);
  });
});

describe("OAuth provisioning: the notice", () => {
  it("names the provider and lists what is missing", () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    const el = dom.window.document.body as unknown as HTMLElement;
    (el as unknown as { createEl: unknown }).createEl = function (
      this: HTMLElement,
      tag: string,
      o?: { text?: string; href?: string; cls?: string }
    ) {
      const child = dom.window.document.createElement(tag);
      if (o?.text !== undefined) child.textContent = o.text;
      if (o?.href !== undefined) child.setAttribute("href", o.href);
      if (o?.cls !== undefined) child.className = o.cls;
      (child as unknown as { createEl: unknown }).createEl = (
        el as unknown as { createEl: unknown }
      ).createEl;
      this.appendChild(child);
      return child;
    };

    renderUnconfiguredProvider(el, "OneDrive", ["ONEDRIVE_CLIENT_ID"]);

    const text = el.textContent ?? "";
    assert.ok(text.includes("OneDrive"), "should name the provider");
    assert.ok(
      text.includes("ONEDRIVE_CLIENT_ID"),
      "should list the missing credential"
    );
    assert.equal(el.querySelectorAll("li").length, 1);
  });
});
