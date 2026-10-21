# Catalog Preparation

This private repository prepares the data served by `sourceindex/view-index`.
The public repository contains catalog JSON only. Never commit scripts,
documentation, workflows, credentials, or personal account identities there.

The workflow runs every four hours and can be started manually. Public catalog
edits are included on the next run; dispatch the private workflow for an
immediate refresh. Metadata expiry, source handling, and output schema are
unchanged from the publisher implementation.

`CATALOG_REPOSITORY` selects the output repository. `CATALOG_COMMIT_EMAIL` must
remain the sourceindex account's numeric GitHub noreply address. Publishing uses
a write deploy key restricted to the output repository, not another account.

GitHub Actions private-runner usage counts against the account allowance.
No paid spending has been enabled by this setup.
