# Contributing

## Getting set up

```bash
npm install
npx hardhat compile
npx hardhat test
```

Node 20 or newer. Nothing else is needed: no API key, no signup, and no funded account for the
test suite, which runs entirely against a local network with the protocol mocked.

## Before opening a pull request

- `npx hardhat test` passes.
- `npx tsc --noEmit` is clean.
- Check both by exit code rather than by reading the output, since a pipe hides a failure.

## House rules for this repo

- Anything that talks to the protocol gets checked against live Shannon before it is claimed to
  work. The mocks encode behaviour we observed, and they are only as good as that observation.
- If you find a place where the platform behaves differently from its documentation, add it to
  `SPIKE-FINDINGS.md`. That file is as valuable as the code.
- Name tests after the claim they defend, not after the function they call.
