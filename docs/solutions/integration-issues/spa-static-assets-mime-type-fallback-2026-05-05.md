---
title: "ASP.NET Core SPA fallback returns index.html with text/html MIME for JS/CSS assets"
date: 2026-05-05
category: integration-issues
module: PRism.Web
problem_type: integration_issue
component: tooling
symptoms:
  - "Browser white screen with console error: Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of text/html"
  - "GET /assets/index-*.js returns Content-Type: text/html (length 390 — the index.html fallback) instead of text/javascript"
  - "GET / returns 404 ProblemDetails JSON because the SPA fallback regex {*path:regex(^(?!api/).*$)} does not match the empty root path"
  - "dotnet run launched on port 5256 (template default) instead of the configured 5180–5199 range, bypassing the intended host binding"
  - "Playwright dev-mode tests pass against Vite (port 5173) while the single-binary .NET serving path (port 5180) has zero E2E coverage and ships broken"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [aspnet-core, dotnet-10, static-files, spa-fallback, vite, playwright, mime-type, single-binary]
---

# ASP.NET Core SPA fallback returns index.html with text/html MIME for JS/CSS assets

## Problem

After landing the Web host's composition root for **PRism** (a local-first PR review tool built on .NET 10 + ASP.NET Core minimal APIs + React + Vite + TypeScript, shipped as a single binary), `dotnet run --project PRism.Web` produced a white browser screen at `http://localhost:5180/`. The .NET host returned `Content-Type: text/html` for every file under `wwwroot/assets/` — including hashed JavaScript and CSS bundles — instead of the correct `text/javascript` / `text/css`.

The body served for those asset URLs was the SPA `index.html` itself, meaning requests for static assets were being silently swallowed by the SPA fallback rather than served as files. The bundles existed on disk, were referenced by the correct hash in `index.html`, and were present in the static-web-assets manifest — they just never got served.

## Symptoms

1. Browser shows a white screen at `http://localhost:5180/`.
2. DevTools console reports:
   ```
   Failed to load module script: Expected a JavaScript-or-Wasm module script
   but the server responded with a MIME type of "text/html". Strict MIME type
   checking is enforced for module scripts per HTML spec.
   ```
3. `curl -sI http://localhost:5180/assets/index-ZPuBkJih.js` returns `Content-Type: text/html` with `Content-Length: 390` — the exact size of the SPA fallback `index.html`, confirming the asset request was being rewritten to the SPA entry point.
4. Behavior was inconsistent across configurations: Release builds *occasionally* served correct `text/javascript`; Debug builds never did. No code differences between the two — only the build configuration.
5. After an initial "fix" registering `UseStaticFiles` plus a regex SPA fallback, `GET /` started returning a 404 ProblemDetails because the regex pattern `{*path:regex(^(?!api/).*$)}` required at least one character and so refused to match the empty path.

## What Didn't Work

Each of the following hypotheses was investigated and ruled out before the real cause surfaced:

1. **Stale `wwwroot` / hash mismatch.** Verified `wwwroot/assets/index-ZPuBkJih.js` existed on disk and matched the hash referenced from `wwwroot/index.html`. Not the cause.
2. **Browser cache from an earlier broken state.** Hard refresh and full cache clear — same behavior.
3. **Port collision / stale processes on 5180.** Killed all `dotnet.exe` and `node.exe` processes via `taskkill /F /IM`. Same behavior.
4. **Missing `UseStaticFiles` in `Program.cs`.** Verified it was registered, in the correct order — after middleware, before endpoint mapping.
5. **Wrong `WebRootPath` / content root.** Added a debug endpoint printing `IWebHostEnvironment.ContentRootPath`, `WebRootPath`, and file existence checks. All were correct: content root was `PRism.Web`, web root was `PRism.Web/wwwroot`, files existed.
6. **`WebRootFileProvider` not finding files.** Added middleware that probed the `WebRootFileProvider` directly via `fp.GetFileInfo(subpath)`. Result: `exists=True`, `physicalPath=<correct full path>`, provider type was `CompositeFileProvider`. The file provider knew about the files — `UseStaticFiles` simply wasn't serving them.
7. **Static-web-assets manifest excluding the file.** Read `bin/Debug/net10.0/PRism.Web.staticwebassets.runtime.json` directly. The asset was in the manifest with the correct path.
8. **Using an explicit `PhysicalFileProvider`.** Passed one to `UseStaticFiles` to bypass the `CompositeFileProvider`. Still didn't serve.
9. **Wrapping `UseStaticFiles` in diagnostic middleware.** Confirmed requests entered the static files middleware, exited without writing a response (`hasStarted=False`), and were then caught by the SPA fallback which rewrote the path to `/index.html`.

The breakthrough came from noticing two clues already on disk: the `CompositeFileProvider` and the `.staticwebassets.runtime.json` manifest. Together they pointed at a new .NET 9/10 asset-serving system that supersedes `UseStaticFiles` — but does not engage through it.

## Solution

A single change in `PRism.Web/Program.cs` resolved the asset serving — replacing `UseDefaultFiles()` + `UseStaticFiles()` with `MapStaticAssets()`:

```csharp
// BEFORE (silently broken in .NET 10):
app.UseDefaultFiles();
app.UseStaticFiles();

// AFTER (works):
app.MapStaticAssets();
```

A second change fixed the fallback so `GET /` would no longer 404 while still preventing the SPA from swallowing unknown API routes:

```csharp
// BEFORE (404 on GET /):
app.MapFallbackToFile("{*path:regex(^(?!api/).*$)}", "index.html");

// AFTER (handles / + still 404s for unknown /api/*):
app.MapFallback("/api/{*rest}", () => Results.NotFound());
app.MapFallbackToFile("index.html");
```

`MapFallback("/api/{*rest}", ...)` is more specific than `MapFallbackToFile("index.html")`, so unknown `/api/*` paths route to the 404 endpoint while everything else falls through to the SPA's `index.html`.

A separate ergonomics fix in `PRism.Web/Properties/launchSettings.json` pinned the `http` profile to port 5180 (matching the dev workflow + Playwright config) and disabled the IDE's auto-launch (Program.cs handles browser launch itself):

```jsonc
{
  "profiles": {
    "http": {
      "commandName": "Project",
      "dotnetRunMessages": true,
      "launchBrowser": false,
      "applicationUrl": "http://localhost:5180",
      "environmentVariables": { "ASPNETCORE_ENVIRONMENT": "Development" }
    }
  }
}
```

## Why This Works

**On `MapStaticAssets`.** Starting with .NET 9, the Web SDK generates a build-time static-web-assets manifest (`<Project>.staticwebassets.runtime.json` and a paired `.endpoints.json`) describing every asset along with optimized response metadata — precompressed variants, cache-control, and ETags. `MapStaticAssets()` is a new endpoint-routed API that consumes this manifest directly and registers an endpoint per asset in the routing pipeline.

`UseStaticFiles()` is the legacy middleware-based API. In .NET 10, with the asset manifest present, `UseStaticFiles` deferred to the new manifest system but failed to actually write a response — middleware diagnostics showed requests entering and exiting the static files middleware with `hasStarted=False`, after which the SPA fallback rewrote the URL to `/index.html`. `MapStaticAssets()` *is* the serving mechanism the manifest was designed for, so it works correctly where `UseStaticFiles` does not.

**On the fallback.** ASP.NET Core routing selects the most specific matching endpoint. `MapFallback("/api/{*rest}", ...)` is strictly more specific than `MapFallbackToFile("index.html")` (which uses the default `{*path:nonfile}` pattern), so unknown `/api/*` requests resolve to the explicit 404 endpoint instead of being absorbed by the SPA fallback. The default `MapFallbackToFile` pattern correctly matches the empty path, so `GET /` returns `index.html` as intended.

## Prevention

Three layered defenses keep this class of bug from recurring:

1. **Use `MapStaticAssets()` in any new .NET 9+ ASP.NET Core project that ships a frontend bundle.** `UseStaticFiles()` is legacy and silently misbehaves once the static-web-assets manifest is present. The ASP.NET Core 9 release notes call out `MapStaticAssets` as the recommended replacement; treat any project still using `UseStaticFiles` for SPA assets as a migration candidate.

2. **Test the production single-binary serving path with E2E.** This bug existed because Playwright only ran against the Vite dev server, which serves the frontend itself and proxies API calls to .NET. The .NET-serves-everything path is what actually ships, and it had zero coverage. Add a `prod` Playwright project that runs against the .NET backend on port 5180 directly, using `globalSetup` to populate `wwwroot` via `npm run build` before the suite starts:

   ```ts
   // frontend/playwright.config.ts
   projects: [
     { name: 'dev',  use: { browserName: 'chromium', baseURL: 'http://localhost:5173' } },
     { name: 'prod', use: { browserName: 'chromium', baseURL: 'http://localhost:5180' } },
   ],
   globalSetup: './e2e/global-setup.ts',  // runs `npm run build`
   ```

   The first run of the new `prod` project surfaced the bug in three of four cold-start tests immediately — exactly what it was designed to catch.

3. **Cover the static-file and fallback invariants with `WebApplicationFactory` tests.** Add `tests/PRism.Web.Tests/StaticFilesAndFallbackTests.cs` asserting two invariants: client-side routes do not return ProblemDetails, and unknown `/api/*` paths return 404 (not HTML). These are cheap, in-memory tests that catch wrong-fallback bugs without needing a real browser:

   ```csharp
   [Fact]
   public async Task Unknown_api_route_returns_404_not_SPA_fallback()
   {
       using var factory = new PRismWebApplicationFactory();
       var client = factory.CreateClient();

       var resp = await client.GetAsync(
           new Uri("/api/this-endpoint-does-not-exist", UriKind.Relative));

       resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
       resp.Content.Headers.ContentType?.MediaType.Should().NotBe("text/html");
   }
   ```

## Related Issues

- Commits on `spec/foundations`: `12bfecc` (initial — but broken — UseStaticFiles + regex fallback) and `de60dc1` (the MapStaticAssets + split-fallback fix).
- Foundations slice spec: [`docs/superpowers/specs/2026-05-05-foundations-and-setup-design.md`](../../superpowers/specs/2026-05-05-foundations-and-setup-design.md) (T30 composition root).
- No prior `docs/solutions/` entries — this is the first.

## A note on schema fit

The `component` field's enum is Rails-shaped (`rails_model`, `rails_controller`, `service_object`, `frontend_stimulus`, `hotwire_turbo`, etc.) with no .NET-specific value. The closest defensible fit for "ASP.NET Core host serving Vite-built frontend assets" is `tooling`, treating this as a build/serve infrastructure concern even though the bug also lives in production request-handling code. A reader expecting the component to map cleanly onto Rails-style frontend-asset terminology will find the categorization imperfect; the imperfection is in the schema, not the doc.
