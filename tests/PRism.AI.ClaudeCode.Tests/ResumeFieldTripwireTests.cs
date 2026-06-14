using System.Text.RegularExpressions;
using FluentAssertions;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ResumeFieldTripwireTests
{
    // TRIPWIRE (spec §5 / #479): ResumeSessionId reaches a real `claude --resume` spawn, but ownership of
    // the id is verified ONLY at the application-service layer that #412 introduces — sequenced AFTER all
    // P0-1b slices. Until #412 lands, NO production code may SET the field. When #412 adds a normal caller
    // (named-arg, object-initializer, or `with`-expression) this turns RED; the implementer MUST then add
    // the ownership check AND allowlist the caller's file below.
    //
    // KNOWN, ACCEPTED EVASIONS (this catches the realistic accidental caller, not a determined evader; the
    // real authorization control is #412's ownership check, not this test):
    //   - positional construction `new StreamingSessionOptions(null,null,null,null,null,id)` (6 positional
    //     args — conspicuous and caught in code review),
    //   - reflection / options-binding by the string key "ResumeSessionId" (config),
    //   are NOT matched by the assignment regex below.
    [Fact]
    public void No_production_code_sets_ResumeSessionId_until_412()
    {
        var root = FindRepoRoot();
        // Path-relative allowlist (NOT filename-only): only THIS declaration file may mention the field as
        // a `= null` default. A same-named file elsewhere must not be auto-allowlisted.
        var allow = new[] { Path.Combine("PRism.AI.Contracts", "Provider", "StreamingSessionOptions.cs") };
        var setter = new Regex(@"ResumeSessionId\s*[:=]");    // named-arg, object-initializer, or `with` assignment
        var offenders = ProductionCsFiles(root)
            .Where(f => !allow.Any(a => Path.GetRelativePath(root, f)
                .Replace('/', Path.DirectorySeparatorChar).EndsWith(a, StringComparison.OrdinalIgnoreCase)))
            .Where(f => setter.IsMatch(File.ReadAllText(f)))
            .Select(f => Path.GetRelativePath(root, f))
            .ToArray();

        offenders.Should().BeEmpty(
            "ResumeSessionId must not be set by any production caller until #412 adds the ownership check; "
            + "if #412 is landing, add the caller's ownership-verifying file to the allowlist");
    }

    // Walks up to the NEAREST PRism.sln. A git worktree carries its OWN PRism.sln, so this scans only this
    // worktree's tree — sibling worktrees (which nest under the primary checkout, not under this root) are
    // not enumerated.
    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "PRism.sln"))) dir = dir.Parent;
        dir.Should().NotBeNull("the test must run inside the PRism repo (PRism.sln not found walking up)");
        return dir!.FullName;
    }

    private static IEnumerable<string> ProductionCsFiles(string root)
    {
        var sep = Path.DirectorySeparatorChar;
        return Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains($"{sep}tests{sep}", StringComparison.OrdinalIgnoreCase))
            .Where(f => !f.Contains($"{sep}bin{sep}", StringComparison.OrdinalIgnoreCase))
            .Where(f => !f.Contains($"{sep}obj{sep}", StringComparison.OrdinalIgnoreCase));
    }
}
