# Indexer Replay CLI

`scripts/indexer-replay.ts` replays governance events from a starting Stellar ledger.

## Usage

```bash
npx ts-node scripts/indexer-replay.ts [--start-ledger <ledger>]
```

The replay ledger can also be supplied through `START_LEDGER`. The positional
`ledger` form remains accepted for backward compatibility:

```bash
START_LEDGER=12345 npx ts-node scripts/indexer-replay.ts
npx ts-node scripts/indexer-replay.ts --start-ledger 12345
npx ts-node scripts/indexer-replay.ts 12345
```

Ledger 1 is the default when neither form supplies a value.

## Validation and failure behavior

- A positive, safely representable integer is required.
- `--start-ledger` without a value, unknown flags, duplicate values, extra
  positional arguments, and invalid ledger values exit with status 1.
- `--help` prints usage and exits successfully.
- Replay failures roll back the database transaction and close the database
  pool before exiting with status 1.

## Security assumptions

- Ledger values are bounded to JavaScript's safe integer range to prevent
  imprecise replay boundaries.
- Replay database work remains in one transaction.
- Sentinel locking and `NOWAIT` preserve the live indexer's serialized state.
