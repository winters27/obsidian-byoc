// OAuth client credentials are injected at build time by webpack's DefinePlugin,
// which reads them from the release environment. A provider whose app was never
// registered therefore ships with an empty string, and nothing notices until the
// provider itself rejects the request in its own words: OneDrive answers
// "AADSTS900144: the request body must contain 'client_id'", Box answers
// "invalid_client". Both read like the user broke something. Catch it here and
// say plainly that this build has no credentials for the provider.

/** Names of the credentials that are missing (empty) from the given set. */
export function findMissingCredentials(
  credentials: Record<string, string | undefined>
): string[] {
  return Object.entries(credentials)
    .filter(([, value]) => (value ?? "").trim() === "")
    .map(([name]) => name);
}

/**
 * Replaces the body of an auth modal with an explanation, for the case where the
 * provider has no usable credentials. `userKeyHint` is shown when the provider
 * also accepts a key the user supplies in settings, as Dropbox does.
 */
export function renderUnconfiguredProvider(
  contentEl: HTMLElement,
  providerName: string,
  missing: string[],
  userKeyHint?: string
): void {
  contentEl.createEl("p", {
    text: `This build of BYOC does not carry OAuth credentials for ${providerName}, so authorization cannot start. Without them ${providerName} rejects the request before you can sign in.`,
    cls: "setting-item-description",
  });

  if (userKeyHint !== undefined) {
    contentEl.createEl("p", {
      text: userKeyHint,
      cls: "setting-item-description",
    });
  }

  contentEl.createEl("p", {
    text: "If you build BYOC yourself, set these before building and the option becomes available:",
    cls: "setting-item-description",
  });

  const list = contentEl.createEl("ul", { cls: "byoc-missing-credentials" });
  missing.forEach((name) => list.createEl("li", { text: name }));

  contentEl.createEl("a", {
    href: "https://github.com/winters27/obsidian-byoc/issues",
    text: "Report this on GitHub",
    cls: "external-link",
  });
}
