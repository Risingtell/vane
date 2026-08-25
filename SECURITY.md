# Security policy

Vane is testnet software. It holds test collateral on Somnia Shannon and is not audited.

## Reporting

Report anything you find privately to risingtell@gmail.com rather than opening a public issue.
A short description and the steps to reproduce is plenty.

## What the design guarantees

- `withdraw` is owner-only and has no other condition. It does not depend on the strategy, the
  operator, the pause flag or the chain subscription.
- The operator may trigger trading and nothing else. It can never move collateral.
- `reclaimExpired` and `sweepSettled` are permissionless, so funds cannot be stranded by an
  operator that disappears. Both credit the agent, never the caller.
- `rescueToken` cannot touch the trading collateral, so it is not a back door.
- `onEvent` reverts unless the caller is the reactivity precompile.

## What it does not guarantee

- No audit. No formal verification.
- The collateral does sit in a contract, because DreamDEX offers no way for a third party to
  trade event contracts on an owner's behalf. See the custody section of the README.
- Open positions are valued at book cost, not marked to market.
