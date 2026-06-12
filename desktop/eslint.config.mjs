// Type-aware ESLint for the Electron desktop shell (#335). Desktop previously had
// NO lint at all — a PR touching desktop/src/*.ts got zero lint. The headline value
// is the two TYPE-AWARE promise rules (no-floating-promises / no-misused-promises)
// on async sidecar + IPC code: exactly the lifecycle bug class #336 fixed.
//
// Bounded ruleset by design: js/ts `recommended` (syntactic) PLUS those two typed
// rules — NOT the full `recommendedTypeChecked` preset, which would surface a large
// triage on previously-unlinted code and balloon this CI-hardening PR.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // dist/dist-test are tsc output; sidecar/ is the published backend binary; the
    // config file lints itself otherwise (it is plain ESM, not project TS).
    ignores: [
      "dist/**",
      "dist-test/**",
      "node_modules/**",
      "sidecar/**",
      "eslint.config.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        // Type-aware linting. The build tsconfigs don't span every linted file
        // (tsconfig.json → src/** only; root config files are in neither), and
        // projectService only honors the default tsconfig.json — so point at a
        // dedicated lint project that includes src + test + the root configs.
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TS itself reports undefined identifiers; no-undef double-reports Node/Electron
      // globals (process, Buffer, console, setTimeout, …) and is off per typescript-eslint
      // guidance for typed code.
      "no-undef": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    // node:test registers tests by CALLING test()/describe(), which each return a
    // promise the runner owns and you never await; async test callbacks are likewise
    // the runner's contract. Both type-aware promise rules therefore fire on correct
    // test-runner idiom, not real bugs — relax them for test files only. Production
    // code under src/ (where a floating promise IS a bug, e.g. the #336 class) keeps
    // full coverage. Must be the LAST block so it overrides the src rules above.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
    },
  },
);
