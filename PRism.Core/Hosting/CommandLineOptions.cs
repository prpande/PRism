namespace PRism.Core.Hosting;

/// <summary>
/// Reads option values directly from the raw <c>argv</c> array, independent of the
/// .NET command-line <em>configuration</em> provider.
/// </summary>
/// <remarks>
/// The configuration provider auto-registered by <c>WebApplication.CreateBuilder(args)</c>
/// has no concept of a valueless flag: a bare <c>--no-browser</c> is treated as a key
/// that consumes the <em>next</em> token as its value. When the sidecar passes
/// <c>["--no-browser", "--dataDir", path]</c> the bare flag swallows <c>--dataDir</c>,
/// so <c>Configuration["DataDir"]</c> never receives <paramref name="optionName"/>'s
/// value. Parsing argv here makes flag <em>order</em> irrelevant.
/// </remarks>
public static class CommandLineOptions
{
    /// <summary>
    /// Returns the value of <paramref name="optionName"/> from <paramref name="args"/>,
    /// supporting both <c>--name value</c> and <c>--name=value</c> forms (option name
    /// matched case-insensitively), or <c>null</c> when the option is absent or carries
    /// no value.
    /// </summary>
    /// <param name="args">The raw command-line arguments.</param>
    /// <param name="optionName">The option to read, including its leading dashes (e.g. <c>--dataDir</c>).</param>
    public static string? GetValue(IReadOnlyList<string> args, string optionName)
    {
        ArgumentNullException.ThrowIfNull(args);
        ArgumentException.ThrowIfNullOrEmpty(optionName);

        var equalsPrefix = optionName + "=";

        for (var i = 0; i < args.Count; i++)
        {
            var arg = args[i];

            // --name=value
            if (arg.StartsWith(equalsPrefix, StringComparison.OrdinalIgnoreCase))
            {
                var inlineValue = arg[equalsPrefix.Length..];
                // "--name=" with nothing after the '=' is a missing value, not "" —
                // return null so the caller's fallback chain (config, then OS resolver)
                // runs instead of poisoning downstream Path.Combine calls with "".
                return inlineValue.Length == 0 ? null : inlineValue;
            }

            // --name value — but only when a real value token follows, not another
            // flag. A trailing "--name" (no token after), "--name --flag", or an empty
            // value token is a missing value and yields null so the caller's fallback
            // chain runs. (A data directory never legitimately starts with '-', so
            // treating a '-'-prefixed next token as a flag is safe here.)
            if (string.Equals(arg, optionName, StringComparison.OrdinalIgnoreCase))
            {
                if (i + 1 < args.Count && args[i + 1].Length > 0 && !args[i + 1].StartsWith('-'))
                {
                    return args[i + 1];
                }

                return null;
            }
        }

        return null;
    }
}
