export const DENIED_DEPLOYMENTS: ReadonlyArray<{ name: string; role: string }> = [
  { name: "doting-barracuda-47", role: "staging" },
  { name: "robust-puffin-632", role: "production" },
  { name: "lovely-iguana-785", role: "staging mirror" },
  { name: "quick-shrimp-59", role: "production mirror" },
]

export const DENY_ENV_VARS = ["E2E_STAGING_CONVEX_DEPLOYMENT", "E2E_PRODUCTION_CONVEX_DEPLOYMENT", "E2E_DENY_CONVEX_DEPLOYMENTS"]
