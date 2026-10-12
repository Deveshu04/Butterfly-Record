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

The CI workflow runs two jobs on Windows for every pull request and every push to
`main`, and both must pass before a change is merged:

- **Checks**: type checks, unit tests, the extension and app interface builds, and the
  Rust checks.
- **Desktop e2e**: builds the Windows app and runs the smoke test against it, recording
  a generated screen, camera and microphone.

Run the checks yourself first:

```
pnpm check                                          # typecheck every package
pnpm test                                           # unit tests: core, desktop and share server
node --test "scripts/*.test.mjs"                    # tests for the repository scripts
pnpm build                                          # extension into dist/chrome-mv3
pnpm --filter @butterfly-record/desktop vite:build  # Windows app interface
```

and then, from `packages/desktop/src-tauri`, the Rust checks:

```
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

To run the end-to-end job the way CI does, build the app without the installer and run
the smoke test with generated input (PowerShell, with Butterfly Record not running):

```
pnpm --filter @butterfly-record/desktop tauri build --no-bundle
cd e2e
npm ci
$env:SMOKE_CAPTURE = 'fake'
npm run smoke:desktop
```

When it fails in CI, the run's `desktop-e2e` artifact holds the test report, the console
and app logs, and a screenshot of the main window.

`pnpm desktop:build` builds the full Windows installer when you need to try it.

The e2e package also has a Playwright harness that records with the built extension in
Chromium; [e2e/README.md](e2e/README.md) describes every script and option.

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

Releases are built and published by the repository's GitHub Actions release workflow
when a version tag is pushed:

1. Run `pnpm version:set <x.y.z>`. It writes the version to every file that records it,
   including the `package.json` files and the Windows app's `Cargo.toml` and
   `Cargo.lock`. Commit the change and get it onto `main` like any other change.
2. Tag that commit and push the tag:

   ```
   git tag v<x.y.z>
   git push origin v<x.y.z>
   ```

3. The workflow stops if the tag does not match the version in those files. Otherwise it
   runs the CI jobs, builds the installer and the extension, and publishes a release on
   the [Releases](https://github.com/butterfly-labs/butterfly-record/releases) page with
   `Butterfly.Record_<x.y.z>_x64-setup.exe` (release files cannot have spaces in their
   names), `butterfly-record-extension-<x.y.z>.zip` and `SHA256SUMS.txt`. A version
   with a pre-release suffix, such as `1.2.0-rc.1`, is published as a pre-release.

If any job fails, nothing is published. Re-run the failed jobs if the failure was not
caused by the code; otherwise fix it on `main`, then move the tag to the fixed commit
with `git tag -f v<x.y.z>` and `git push -f origin v<x.y.z>`.

## Licence

By contributing, you agree that your contributions are licensed under the
[MIT licence](LICENSE).
