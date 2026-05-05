import { execSync } from 'node:child_process';

// Build the frontend before the prod-mode Playwright project runs so the .NET backend has
// content to serve out of wwwroot. Cheap (~1s) and harmless for the dev project.
export default async function globalSetup() {
  console.log('[playwright] building frontend so wwwroot is current…');
  execSync('npm run build', { stdio: 'inherit' });
}
