# Evaluation: `eslint-plugin-jsx-a11y-x` 0.2.0 (decision D10)

- Status: **Evaluation only. Not a dependency of the main workspace** (owner decision 2026-11-17)
- Date: 2026-11-17
- Method: isolated scratch project (ESLint 10.15.0, typescript-eslint 8.73.0, TypeScript 6.0.3)
  with known-good and known-bad TSX fixtures. Nothing was added to the repository's
  `package.json` or lockfile.

## Compatibility

| Check                                                                   | Result                                                                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Declared peer range                                                     | `eslint: ^9.0.0 \|\| ^10.0.0`                                                                            |
| Loads and runs under ESLint 10.15.0 (flat config)                       | Yes                                                                                                      |
| Rule parity with upstream `eslint-plugin-jsx-a11y` 6.10.2               | 36 of 39 rules. Missing: `accessible-emoji`, `label-has-for`, `no-onchange`, all **deprecated upstream** |
| `recommended` preset                                                    | 34 rules                                                                                                 |
| Component mapping (`settings['jsx-a11y-x'].components = { Link: 'a' }`) | Works: `<Link href="#">` is reported by `anchor-is-valid`                                                |
| Current `apps/web` code                                                 | 0 findings (checked during the M0 review trial)                                                          |

## False positives and false negatives

**Known-good fixture** (labelled form controls via `htmlFor` and wrapping, `useId`, `next/link`,
`next/image` with alt, decorative `alt=""`, captions track, disclosure button with
`aria-expanded`/`aria-controls`, `role="status"`, `<dialog>`, table with caption/`scope`, prop
spreading onto `<button>`): **0 reports (0 false positives).**

**Known-bad fixture** (14 single-violation elements): 12 of 14 flagged.

- Correctly flagged: missing `alt`, click without key handler, static element interaction,
  `href="#"` on `<a>` and on `<Link>`, invalid `aria-pressed` value, empty heading, invalid role,
  positive `tabIndex`, `tabIndex` on a non-interactive element, empty `lang`, `iframe` without
  title, `autoFocus`.
- Not flagged:
  - A bare unlabelled `<input>`: `control-has-associated-label` is not in `recommended`, the
    same as upstream.
  - `aria-hidden` on a focusable link: not covered by `recommended`.
  - Both can be enabled explicitly if adopted.

**Upstream comparison**: upstream `eslint-plugin-jsx-a11y` 6.10.2 also loads under ESLint 10 at
runtime, despite declaring `eslint ≤ 9`. On the same fixtures it gave identical results (0 on good,
13 reports on bad). Its blocker is the undeclared support, not observed breakage.

## Maintenance risk

| Signal              | Observation                                                                                                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioning          | 0.x (0.1.0, 0.1.1, 0.2.0). The latest npm release is 0.2.0 (2026-05). Pre-1.0 releases may break between minors.                                                                                                                                                     |
| Repository activity | 14 commits since 2026-05-21; latest 2026-10-27 (`switch to picomatch`). CI, release and Dependabot workflows are present. Commits after 0.2.0 are **unreleased**.                                                                                                    |
| Maintainers         | One npm maintainer. Multiple contributors in the git history. A 2026-10 commit updates repository links to the `eslint-community` org, suggesting a move under community governance (not yet reflected on npm).                                                      |
| Dependencies        | `minimatch ^10.2.5` in 0.2.0. This is **inside** the range of GHSA-g3hv-75wg-m249 (moderate, `>=7.0.0 <11.0.1`), so adopting 0.2.0 would bring back the `pnpm audit` finding that M0 removed. The unreleased `main` switches to `picomatch`, which would resolve it. |
| Security advisories | No advisory against the plugin itself was found. `pnpm audit` was not run with the plugin installed (the trial was isolated); its transitive `minimatch` would be flagged (see above).                                                                               |

## Recommendation (for a later decision; nothing changes now)

1. Keep it out of the main workspace for now, as the owner decided.
2. Re-evaluate when **either** a 0.3+/1.0 release ships from the `eslint-community` home
   (it should also clear the `minimatch` advisory), **or**
   upstream `eslint-plugin-jsx-a11y` declares ESLint 10 support.
3. If adopted: web files only, `recommended` plus `control-has-associated-label`, pinned exactly,
   and introduced in a separate PR so it can be reverted on its own.
4. Until then, accessibility is checked in code review and by the planned Playwright E2E tests
   (M1 step 9). Consider adding `@axe-core/playwright` to those tests, which needs no ESLint
   dependency (to be proposed with the E2E work).
