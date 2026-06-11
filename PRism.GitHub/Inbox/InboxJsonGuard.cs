using System.Text.Json;

namespace PRism.GitHub.Inbox;

/// <summary>
/// True for the exception set that signals a single malformed JSON item (a missing
/// property, a wrong value kind, an unparseable timestamp, or a non-JSON body) — as
/// opposed to a transport failure, cancellation, or rate-limit, which must still
/// propagate and abort the tick. Used to isolate one poisoned inbox item from the
/// rest of the batch. (#322)
/// </summary>
internal static class InboxJsonGuard
{
    public static bool IsMalformedItem(Exception ex) =>
        ex is KeyNotFoundException     // GetProperty on a missing key
           or InvalidOperationException // wrong JsonValueKind (GetString/GetInt32/EnumerateArray)
           or FormatException           // parse failures, e.g. GetDateTimeOffset on a bad string
           or OverflowException         // GetInt32/GetInt64 on a numeric value out of the target range
           or JsonException;            // JsonDocument.Parse on a non-JSON body
}
