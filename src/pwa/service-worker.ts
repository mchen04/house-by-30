export function renderServiceWorker(buildId: string): string {
  return [
    'import { startServiceWorker } from "/sw-runtime.js";',
    `startServiceWorker(self, ${JSON.stringify(buildId)});`,
    "",
  ].join("\n");
}
