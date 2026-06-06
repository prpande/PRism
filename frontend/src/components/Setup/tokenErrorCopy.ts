// Maps backend AuthValidationError codes (lowercased enum names) to user-facing
// copy. Shared by the connect flow (inline pill, SetupForm) and the replace flow
// (toast, SetupPage). `insufficientscopes` is classic-only by construction —
// GitHubReviewService only emits it for ghp_ tokens — so it names the classic
// scopes; there is no fine-grained variant. The fallback is STATIC: it never
// echoes the raw `code` into the UI. (#213)
const REJECTED =
  'GitHub rejected this token. Check that you copied the whole token, then try again.';
const CLASSIC_SCOPES =
  'This token is missing required scopes. A classic token needs repo and read:org.';
const NETWORK = "Couldn't reach GitHub. Check your connection, then try again.";
const SERVER = 'GitHub returned a server error. Try again in a moment.';
const GENERIC = 'Validation failed. Check your token and try again.';

export function connectErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'invalidtoken':
    case 'validation-failed':
      return REJECTED;
    case 'insufficientscopes':
      return CLASSIC_SCOPES;
    case 'networkerror':
    case 'dnserror':
      return NETWORK;
    case 'servererror':
      return SERVER;
    default:
      return GENERIC;
  }
}

export function replaceErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'submit-in-flight':
      return 'A submit started during your token paste. Try Replace again in a moment.';
    case 'pat-required':
      return 'Paste your new token before continuing.';
    case 'invalid-json':
      return 'Internal error while parsing the token. Please refresh and try again.';
    default:
      return connectErrorMessage(code);
  }
}
