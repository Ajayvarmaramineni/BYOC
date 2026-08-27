## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- What problem does this solve? For a bug fix, what was the user-visible symptom? -->

## Checklist

- [ ] Tests pass in every affected SDK
  - TypeScript: `npm test && npm run typecheck`
  - Python: `pytest && mypy src && ruff check .`
- [ ] New behaviour has a test that fails without the change
- [ ] Provider-specific logic stays inside its adapter, not in core
- [ ] Public API changes are reflected in the relevant README

## Cross-SDK impact

<!-- Delete if not applicable. -->

- [ ] This touches a surface covered by `spec/fixtures` (paths, encoding, E2EE envelope, provider metadata)
- [ ] Both SDKs were updated together, and the interop suite passes

> Changing a conformance fixture is a breaking change: it can make previously
> written files unreadable. Bump the format version instead of editing a vector
> in place.
