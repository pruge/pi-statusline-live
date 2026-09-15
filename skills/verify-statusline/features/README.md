# statusline verification map

Maintained source for proving the footer package. Scripted checks cover build, units, and contracts; pixels stay manual and are marked as such.

## Baseline preconditions

- Package root as cwd. `node --version` 22+.
- No server started. No fixture data.

## Driving conventions

- Treat every command as literal.
- Never bake secrets into commands — the quota check reads the keychain at runtime.
- A check that needs human eyes says so in its feature file; never claim scripted coverage for it.
