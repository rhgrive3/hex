# Real binary fixtures

The large application binaries used for heavyweight accuracy/oracle checks are intentionally **not tracked by Git**. Normal unit/integration tests must use small generated fixtures.

Pinned metadata lives in `real-binaries.json`. Download locations are supplied at runtime through environment variables so repository source never embeds private or expiring URLs:

- `HEX_FIXTURE_BATTLECATS_URL`
- `HEX_FIXTURE_TSUMTSUM_URL`
- `HEX_FIXTURE_YWP_URL`

Fetch and verify every fixture with:

```sh
npm run fixtures:fetch
```

Or fetch one fixture:

```sh
node scripts/fetch-real-fixtures.mjs battlecats
```

Verify already-downloaded fixtures without network access:

```sh
npm run fixtures:check
```

Files are stored under `tests/.real-fixtures/`, which is ignored by Git. The fetcher rejects non-HTTPS sources and verifies both the exact byte size and SHA-256 digest before atomically installing a fixture.

Heavyweight tests should be opt-in. CI jobs that need these binaries must provide the corresponding URL secrets and run the fetch step explicitly; ordinary pull-request CI must not download them.

Removing the files from the current tree prevents future repository growth, but old blobs remain in existing Git history. Reclaiming historical clone size requires a separately coordinated repository-admin history rewrite (`git filter-repo`/equivalent plus force-push), which is intentionally not performed by a feature pull request.
