# Flaky SPA-fallback test fix — design

**Date:** 2026-05-07
**Scope:** `tests/PRism.Web.Tests/StaticFilesAndFallbackTests.cs` and `tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs`
**Out of scope:** `PRism.Web/Program.cs` (production fallback wiring is correct).

## Problem

`StaticFilesAndFallbackTests.GET_root_does_not_404_due_to_missing_SPA_fallback` is flaky on local runs and (currently) green in CI. Three structural defects in the test cause this:

1. **Name vs. assertion mismatch.** The test name advertises a check on `GET /`, but the test discards that response (`_ = await client.GetAsync(new Uri("/", ...))`) and asserts only on `GET /inbox-shell`.
2. **Weak assertion.** `clientSideResp.Content.Headers.ContentType?.MediaType.Should().NotBe("application/problem+json")` passes when `ContentType` is `null`. A bare 404 with no body would pass even if the SPA fallback were removed entirely.
3. **Environmental coupling.** The pass/fail behavior depends on whether `wwwroot/index.html` exists at test time.

The third defect is the flakiness driver. With `app.UseStatusCodePages()` + `app.UseExceptionHandler()` + `services.AddProblemDetails(...)` registered in `PRism.Web/Program.cs`, a "file not found" 404 from `MapFallbackToFile("index.html")` gets rewritten into a `application/problem+json` response — exactly what the assertion is checking against. CI papers over this with commit `4d32fe1` ("build frontend before .NET tests so wwwroot exists"). Local runs hit it whenever `wwwroot` is empty or stale.

| `wwwroot/index.html` state | Path through pipeline | Content-Type | Test result |
|---|---|---|---|
| Exists, fresh (CI) | `MapFallbackToFile` serves the file | `text/html` | pass |
| Absent (clean local checkout) | Fallback can't find file → 404 → ProblemDetails | `application/problem+json` | fail |
| Stale / partially built | Varies | Varies | flaky |

## Approach

**A. Provide a deterministic stub `wwwroot/index.html` from the test factory.** Override the web root via `builder.UseWebRoot(...)` to point at a temp directory containing a known stub. Both tests then assert positively (200 OK + `text/html` + stub marker in body) without depending on any project-level `wwwroot` state.

Two alternatives were considered and rejected:

- **B. Strengthen the assertion only.** Cheaper but doesn't fix the root cause — the test still depends on whether `wwwroot/index.html` exists, and still doesn't decisively prove the SPA fallback works (just that *something* is registered).
- **C. Inject a custom `IFileProvider` for the web root.** Functionally equivalent to A with slightly more machinery and no real upside. Reserved as a fallback if A turns out to interact badly with `MapStaticAssets()` during implementation.

## Changes

### 1. `tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs`

In `ConfigureWebHost`, alongside the existing `DataDir` setup and before `ConfigureServices`:

- Compute `var webRoot = Path.Combine(DataDir, "wwwroot");`
- `Directory.CreateDirectory(webRoot);`
- Write a recognizable stub to `<webRoot>/index.html`:
  ```html
  <!DOCTYPE html><html><body>PRism test stub</body></html>
  ```
- Call `builder.UseWebRoot(webRoot);`

Cleanup is already handled — the existing `Dispose` deletes `DataDir` recursively, which now contains `wwwroot/`.

### 2. `tests/PRism.Web.Tests/StaticFilesAndFallbackTests.cs`

Replace the single broken test with two positive tests:

- `GET_root_serves_SPA_index_html`
  - `GET /`
  - asserts: `StatusCode == 200`, `ContentType.MediaType == "text/html"`, body contains `"PRism test stub"`.
- `Client_side_route_falls_back_to_SPA_index_html`
  - `GET /inbox-shell`
  - asserts: `StatusCode == 200`, `ContentType.MediaType == "text/html"`, body contains `"PRism test stub"`.

Leave `Unknown_api_route_returns_404_not_SPA_fallback` unchanged — it is already well-formed and passing.

## Why this works

`MapFallbackToFile("index.html")` resolves the file through `IWebHostEnvironment.WebRootFileProvider`, which is bound to the path supplied to `UseWebRoot(...)`. With the stub in place, the file is found, served with `text/html`, and `UseStatusCodePages` never fires because there's no 404 to rewrite. The flakiness root cause (wwwroot dependency) is eliminated.

`MapStaticAssets()` may also serve `GET /` from the build-time manifest if the project's real `wwwroot/index.html` exists when tests run. Both paths produce a passing response (200 + `text/html`); the body marker tells us which one served it. If the manifest claims `GET /` and the marker check fails for the root test, fall back to asserting only status + Content-Type for `GET /` — `/inbox-shell` is not in the manifest, so the marker check on the client-side-route test still proves the fallback path works.

## Risks and unknowns

- **`UseWebRoot(...)` honored by `MapFallbackToFile` after `MapStaticAssets()`?** 95% confidence yes (different code paths — manifest vs. file provider). Verify with one smoke run during implementation. If not, switch to Approach C (custom `IFileProvider`).
- **`MapStaticAssets()` claiming `GET /` and serving real wwwroot content.** Mitigated above (drop marker check for the root test if needed; `/inbox-shell` still asserts the marker).

## Out of scope

- Changes to `PRism.Web/Program.cs`. The production SPA fallback wiring (`MapStaticAssets` + split fallback) is correct and documented in `docs/solutions/integration-issues/spa-static-assets-mime-type-fallback-2026-05-05.md`.
- Refactoring `Unknown_api_route_returns_404_not_SPA_fallback`.
- Touching any frontend or CI configuration.
