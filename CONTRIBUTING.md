# Contributing

Bug reports, questions and pull requests are welcome on
[GitHub](https://github.com/butterfly-labs/butterfly-record/issues). For anything
larger than a small fix, open an issue first so the approach can be agreed before you
spend time on it.

## Setup

You need Node 24 and pnpm 10. For the Windows app you also need Rust (stable, MSVC
toolchain) and Visual Studio Build Tools with the **Desktop development with C++**
workload.

```
pnpm install
pnpm dev             # extension watch build in dist/chrome-mv3-dev, reloaded as you edit
pnpm desktop:dev     # Windows app with hot reload
```

To work on the Windows app's interface without Rust, run it in a normal browser against
an in-memory library:

```
pnpm --filter @butterfly-record/desktop exec vite --mode mock
```

## Checks

The CI workflow runs these on Windows for every pull request and every push to `main`.
Run them yourself first:

```
pnpm check                                          # typecheck every package
pnpm test                                           # unit tests: core, desktop and share server
node --test scripts/set-version.test.mjs            # tests for the version script
pnpm build                                          # extension into dist/chrome-mv3
pnpm --filter @butterfly-record/desktop vite:build  # Windows app interface
```

and then, from `packages/desktop/src-tauri`, the Rust checks:

```
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

`pnpm desktop:build` builds the full Windows installer when you need to try it.

The end-to-end tests record for real: a Playwright harness drives Chromium with the
built extension, and a smoke test drives the built Windows app. They live in a separate
package; [e2e/README.md](e2e/README.md) explains how to install and run them.

## Code style

- Follow the surrounding code: its structure, naming and formatting.
- Keep comments minimal. Write one only when the reason for the code is not obvious from
  the code itself.
- Keep interface text plain and precise.
- If a change stores new data or adds a network request, update
  [PRIVACY.md](PRIVACY.md) in the same pull request. Update the READMEs when a change
  affects what they describe.

## Commit messages

Write the subject in the imperative mood and keep it short, for example
"Fix seeking after a paused recording". Add a body when the reason for the change is not
obvious. A commit message should make sense on its own: do not refer to private
documents, internal notes or other material readers of the repository cannot see.

## Releases

Releases are built by the repository's GitHub Actions release workflow:

1. Run `pnpm run version:set <x.y.z>`. It writes the version to every file that records
   it, including the `package.json` files and the Windows app's `Cargo.toml` and
   `Cargo.lock`. Commit the change.
2. Tag the commit `v<x.y.z>` and push the tag. The workflow stops if the tag does not
   match the version in those files.
3. The workflow builds `Butterfly Record_<x.y.z>_x64-setup.exe` and
   `butterfly-record-extension-<x.y.z>.zip` and attaches them to a draft release on the
   [Releases](https://github.com/butterfly-labs/butterfly-record/releases) page.
4. Review the draft and publish it.

## Licence

By contributing, you agree that your contributions are licensed under the
[MIT licence](LICENSE).
