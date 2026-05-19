using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace PRism.Web.Logging;

// Rewrites M.E.Logging template syntax ({Name}, {Name:format}, {Name,alignment},
// {Name,alignment:format}, {{, }}) to BCL positional placeholders ({0}, {0:format}, etc.)
// in a single scanning pass, then delegates to string.Format(CultureInfo.InvariantCulture, ...).
// The single-pass approach closes the recursion hazard a naive sweep-and-replace parser
// would have: once a positional placeholder is substituted, the result is not re-scanned, so
// a substituted value that happens to contain "{OtherName}" renders verbatim instead of
// leaking the OtherName arg value into the first arg's rendered position.
//
// On malformed templates OR a value's ToString() / IFormattable.ToString() throwing,
// the catch is broad (Exception) — string.Format does NOT wrap value-formatter exceptions
// in FormatException on .NET 10, so a narrow catch(FormatException) would let a
// NullReferenceException from a value's ToString() escape into the request thread.
internal static class LogTemplateFormatter
{
    public static string Format(string template, IReadOnlyDictionary<string, object?> values)
    {
        ArgumentNullException.ThrowIfNull(template);
        ArgumentNullException.ThrowIfNull(values);

        var rewritten = new StringBuilder(template.Length);
        var args = new List<object?>();
        var i = 0;

        try
        {
            while (i < template.Length)
            {
                var c = template[i];

                if (c == '{')
                {
                    // Escaped open-brace: {{ → {
                    if (i + 1 < template.Length && template[i + 1] == '{')
                    {
                        rewritten.Append("{{");
                        i += 2;
                        continue;
                    }

                    // Find the closing '}'. Walk forward until we hit one that isn't part of
                    // an escaped pair. (Within a placeholder, '}}' is not an escape — placeholders
                    // do not contain literal braces. So the first '}' after the '{' is the close.)
                    var close = template.IndexOf('}', i + 1);
                    if (close == -1)
                    {
                        // Malformed: no closing brace. Treat the rest of the template as literal
                        // and let string.Format catch a downstream FormatException — but since the
                        // rewritten output now has an unbalanced '{', we proactively return the
                        // template verbatim instead.
                        return template;
                    }

                    var placeholder = template[(i + 1)..close];  // contents between { and }

                    // Split placeholder into name + optional [,alignment][:format] suffix.
                    var commaIdx = placeholder.IndexOf(',', StringComparison.Ordinal);
                    var colonIdx = placeholder.IndexOf(':', StringComparison.Ordinal);

                    string name;
                    string suffix;  // "" or ",alignment" or ":format" or ",alignment:format"

                    if (commaIdx == -1 && colonIdx == -1)
                    {
                        name = placeholder;
                        suffix = "";
                    }
                    else if (commaIdx != -1 && (colonIdx == -1 || commaIdx < colonIdx))
                    {
                        name = placeholder[..commaIdx];
                        suffix = placeholder[commaIdx..];  // ",alignment" or ",alignment:format"
                    }
                    else
                    {
                        name = placeholder[..colonIdx];
                        suffix = placeholder[colonIdx..];  // ":format"
                    }

                    // Build the positional rewrite: {N[,alignment][:format]}
                    rewritten.Append('{').Append(args.Count).Append(suffix).Append('}');
                    values.TryGetValue(name, out var v);
                    args.Add(v);

                    i = close + 1;
                }
                else if (c == '}')
                {
                    // Escaped close-brace: }} → }
                    if (i + 1 < template.Length && template[i + 1] == '}')
                    {
                        rewritten.Append("}}");
                        i += 2;
                        continue;
                    }

                    // Stray '}' — malformed template. Return verbatim.
                    return template;
                }
                else
                {
                    rewritten.Append(c);
                    i++;
                }
            }

            return string.Format(CultureInfo.InvariantCulture, rewritten.ToString(), args.ToArray());
        }
#pragma warning disable CA1031 // Broad catch is deliberate — see XML doc above.
        catch (Exception)
        {
            return template;
        }
#pragma warning restore CA1031
    }
}
