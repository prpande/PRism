import { execSync } from 'node:child_process';

// Build the frontend before the prod-mode Playwright project runs so the .NET backend has
// content to serve out of wwwroot. Cheap (~1s) and harmless for the dev project.
//
// We ALSO rebuild PRism.Web after the frontend so MapStaticAssets's content-hash manifest
// (`bin/Debug/net10.0/PRism.Web.staticwebassets.endpoints.json`) is regenerated against
// the fresh wwwroot files. Without this, an incremental `dotnet run` skips rebuilding
// (sources unchanged), keeps the stale manifest, and serves the bundle JS/CSS as 200 OK
// with 0 bytes — the SPA never bootstraps and every E2E hangs on Loading…. Building here
// is cheap (~5s when warm) and isolates the fix to E2E setup.
export default async function globalSetup() {
  console.log('[playwright] building frontend so wwwroot is current…');
  execSync('npm run build', { stdio: 'inherit' });
  console.log('[playwright] rebuilding PRism.Web so the static-assets manifest matches wwwroot…');
  execSync('dotnet build PRism.Web --nologo --verbosity minimal', { stdio: 'inherit', cwd: '..' });
}
