export type SpecClass = "tenant" | "seed-lookup"

export const SPEC_TENANT_RECIPES: Readonly<Record<string, string>> = {
  "e2e/accounts-directory.spec.ts": "owner",
  "e2e/ccd-dialog-layout.spec.ts": "owner",
  "e2e/close-rfi.spec.ts": "owner",
  "e2e/co-dashboard.spec.ts": "owner",
  "e2e/co-detail-tabs.spec.ts": "owner",
  "e2e/co-rfi-forward-action.spec.ts": "owner-member",
  "e2e/co-rfi-independence.spec.ts": "owner-verifier",
  "e2e/co-smoke.spec.ts": "owner",
  "e2e/co-story-rfi-inlined.spec.ts": "owner-rfithread",
  "e2e/co-verifier-portal.spec.ts": "owner-verifier",
  "e2e/contract-detail-tabs.spec.ts": "owner",
  "e2e/create-rfi.spec.ts": "owner",
  "e2e/demo-persona-switcher.spec.ts": "owner-verifier-demomode",
  "e2e/doc-viewer-arrows.spec.ts": "owner",
  "e2e/email-bounce-late-reply.spec.ts": "owner-member",
  "e2e/forward-in-story.spec.ts": "owner-member",
  "e2e/new-rfi-from-list.spec.ts": "owner",
  "e2e/outside-respondent.spec.ts": "owner-outside",
  "e2e/record-page-viewer.spec.ts": "owner",
  "e2e/reminder-in-co-story.spec.ts": "owner-member",
  "e2e/respond-rfi.spec.ts": "owner",
  "e2e/rfi-back-to-co.spec.ts": "owner",
  "e2e/rfi-co-story-chronological.spec.ts": "owner",
  "e2e/rfi-co-tab-columns-and-viewer.spec.ts": "owner",
  "e2e/rfi-doc-in-co-documents-tab.spec.ts": "owner",
  "e2e/rfi-forward-existing-no-role.spec.ts": "owner-member",
  "e2e/rfi-recipient-person-chip.spec.ts": "owner-member",
  "e2e/rfi-role-only-external.spec.ts": "owner-member",
  "e2e/rfi-story-creation-entry.spec.ts": "owner",
  "e2e/rfi-story-crosslinks.spec.ts": "owner-outside",
  "e2e/rfis-list-collapsed-landing.spec.ts": "owner",
  "e2e/row-click-opens-rfi.spec.ts": "owner-member",
  "e2e/send-reminder.spec.ts": "owner-member",
  "e2e/signin-route.spec.ts": "owner",
  "e2e/story-attachment-link.spec.ts": "owner",
  "e2e/viewer-size-parity.spec.ts": "owner",
  "e2e/fresh/co-decision-lifecycle.spec.ts": "owner",
  "e2e/fresh/co-lead-review-separation.spec.ts": "owner-two-verifiers",
  "e2e/fresh/co-rfi-bypass.spec.ts": "owner-verifier",
  "e2e/fresh/co-routing-authority.spec.ts": "owner-verifier-member-approvecos",
  "e2e/fresh/co-terminal-stamps.spec.ts": "owner-verifier",
  "e2e/fresh/co-verification-notice.spec.ts": "owner-verifier",
  "e2e/fresh/co-verification-score.spec.ts": "owner-verifier",
  "e2e/fresh/co-verification-spine.spec.ts": "owner-verifier-member",
  "e2e/fresh/comms-delivery-visibility.spec.ts": "owner-member-admin",
  "e2e/fresh/comms-notification-parity.spec.ts": "owner-approver",
  "e2e/fresh/comms-wave1-surfaces.spec.ts": "owner-approver-billing-admin",
  "e2e/fresh/portal-access-grant-scopes.spec.ts": "owner",
  "e2e/fresh/rfi-close-surfaces.spec.ts": "owner-rfithread",
  "e2e/fresh/rfi-thread-scope.spec.ts": "owner-verifier-member-admin-rfithread",
  "e2e/parity/onboarding-admin-provision.spec.ts": "owner-admin",
  "e2e/parity/onboarding-bug-ob-nav.spec.ts": "owner",
  "e2e/parity/onboarding-docx-extract.spec.ts": "owner",
  "e2e/parity/onboarding-email-readonly.spec.ts": "owner",
  "e2e/parity/onboarding-f-items.spec.ts": "owner",
  "e2e/parity/onboarding-field-hygiene.spec.ts": "owner",
  "e2e/parity/onboarding-happy-path.spec.ts": "owner",
  "e2e/parity/onboarding-infra-smoke.spec.ts": "owner-admin",
  "e2e/parity/onboarding-reduced-flow-smoke.spec.ts": "owner",
}

export const SEED_LOOKUP_SPECS: readonly string[] = ["e2e/communications-list.spec.ts"]

export function specKey(file: string): string {
  const posix = file.split("\\").join("/")
  const i = posix.lastIndexOf("/e2e/")
  return i >= 0 ? posix.slice(i + 1) : posix
}

export function specClass(file: string): SpecClass | undefined {
  const key = specKey(file)
  if (key in SPEC_TENANT_RECIPES) return "tenant"
  if (SEED_LOOKUP_SPECS.includes(key)) return "seed-lookup"
  return undefined
}

export function recipeForSpec(file: string): string {
  const recipe = SPEC_TENANT_RECIPES[specKey(file)]
  if (!recipe) {
    throw new Error(
      `[e2e-tenant] ${specKey(file)} has no tenant recipe in e2e/helpers/tenant-recipes.ts, ` +
        `so setup created no tenant for it. Add it there (setup reads the same map).`,
    )
  }
  return recipe
}

export const DRAFT_SPEC_DIR = "e2e/drafts/"

const DRAFT_MEMBER_FIXTURES = ["verifier", "verifier2", "member", "approver", "billing"]

const DRAFT_RECIPES: Readonly<Record<string, string>> = {
  "": "owner",
  verifier: "owner-verifier",
  member: "owner-member",
  approver: "owner-approver",
  billing: "owner-billing",
  "approver,billing": "owner-approver-billing",
  "member,verifier": "owner-verifier-member",
  "verifier,verifier2": "owner-two-verifiers",
}

export function isDraftSpec(file: string): boolean {
  return specKey(file).startsWith(DRAFT_SPEC_DIR)
}

export function draftRecipe(source: string): string | undefined {
  const members = new Set<string>()
  let signedIn = false
  for (const m of source.matchAll(/async\s*\(\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.split(":")[0].trim().replace(/Ch$/, "")
      if (name === "owner") signedIn = true
      if (DRAFT_MEMBER_FIXTURES.includes(name)) {
        signedIn = true
        members.add(name)
      }
    }
  }
  return signedIn ? DRAFT_RECIPES[[...members].sort().join(",")] : undefined
}
