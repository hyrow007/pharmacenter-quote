// Hosts that serve the hub (src/app/hub). Compared after stripping the port
// and a leading "www.". Both domains point at the quote Vercel project.
export const HUB_HOSTS: ReadonlySet<string> = new Set([
  "pharmacenter.app",
  "pharmacenter.tools",
]);
