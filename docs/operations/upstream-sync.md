# Upstream sync

`oh-my-t3code` is a long-lived fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code).
The fork exists to be the best GUI for stock Oh My Pi. Everything the fork adds has to survive
regular merges from upstream, so the rules below are written to keep the fork's diff small and
confined to files upstream rarely touches.

## Remotes

Add `upstream` once per clone:

```sh
git remote add upstream https://github.com/pingdotgg/t3code.git
git fetch upstream
```

`origin` is `git@github.com:yashptel/oh-my-t3code.git`. Never push to `upstream`.

## Branch model

- `main` carries the fork's product history. It tracks `upstream/main` closely and contains
  upstream's commits plus the fork's own commits.
- One feature branch per issue, branched from `main`, merged back with a normal pull request.
- `main` is never rebased onto upstream. Its history is shared with every clone and every
  worktree, and the fork's commits are the product. Rewriting them is not an option.

## Merging upstream

Merge, never rebase. Merge commits keep both histories intact and make the next merge cheaper
because git already knows the common ancestor.

```sh
git checkout main
git fetch upstream
git merge upstream/main
```

When the merge is clean, run the focused checks for anything the merge touched
(`vp run --filter <pkg> typecheck`, `vp test run <files>`), then push `main`.

When the merge conflicts, resolve in this order:

1. **Generated and lock files.** Take upstream's `pnpm-lock.yaml` and regenerate
   (`vp i`) if the fork added dependencies. Never hand-edit a lock file.
2. **Fork-owned files.** Files that only exist in the fork cannot conflict. If git reports one, a
   fork file was renamed or an upstream file landed on the same path. Move the fork file.
3. **Upstream-owned files with a fork touch.** Take upstream's version, then re-apply the fork's
   change by hand. The hot-file table below says what the fork's touch is allowed to be, so the
   re-application is a few lines at most.
4. **Documentation.** `CONTRIBUTING.md`, `README.md`, and `docs/` take the fork's version; fold
   in upstream's factual updates (new commands, renamed scripts) by hand.

Commit the merge with git's default message. Do not squash a merge; the merge commit is the
record that the sync happened.

## Where fork code lives

OMP-specific code lives in files that do not exist upstream:

- `apps/server/src/provider/Drivers/` for the OMP driver.
- `apps/server/src/provider/Layers/` for the OMP runtime layer.
- `apps/server/src/provider/acp/` for protocol code the driver needs.
- `docs/user/providers-omp.md` for the user guide.

Generic changes to files upstream owns are allowed when they are provider-agnostic and would be
accepted upstream as written. A change that mentions OMP by name inside a shared file is not
generic. Route it through the driver instead, using the driver's own `configSchema`
(`apps/server/src/provider/ProviderDriver.ts`) and capability flags.

## Hot files

The table lists the upstream files the fork is most likely to touch, measured by upstream
commits in the six months before the fork was created. The rule is what the fork is allowed to
do in that file, and therefore what you re-apply after taking upstream's side of a conflict.

| File                                                     | Upstream commits / 6mo | Rule                                                                                                                                |
| -------------------------------------------------------- | ---------------------: | ----------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/ChatView.tsx`                   |                    326 | Avoid. Prefer server-side capability or descriptor changes that the existing UI already renders.                                    |
| `apps/web/src/components/chat/ChatComposer.tsx`          |                    143 | Avoid. Add to existing generic selectors instead of adding provider-specific controls.                                              |
| `packages/contracts/src/settings.ts`                     |                    112 | Keep OMP config in the driver's own `configSchema`, not in the closed `providers` struct.                                           |
| `apps/server/src/server.ts`                              |                    100 | One small layer entry only.                                                                                                         |
| `packages/contracts/src/server.ts`                       |                     46 | Add capability flags. Never add provider-name checks.                                                                               |
| `apps/server/src/persistence/Migrations.ts`              |                     40 | No fork migrations. See [Migration numbering](#migration-numbering).                                                                |
| `packages/contracts/src/model.ts`                        |                     28 | All per-driver maps are `Partial<Record<ProviderDriverKind, …>>`. Add an entry only when the driver needs one.                      |
| `apps/server/src/provider/providerStatusCache.ts`        |                     11 | One-line entry in `BUILT_IN_DRIVER_ORDER`.                                                                                          |
| `apps/web/src/components/settings/providerDriverMeta.ts` |                      6 | One entry in `PROVIDER_CLIENT_DEFINITIONS`.                                                                                         |
| `apps/server/src/provider/builtInDrivers.ts`             |                      3 | One import plus one entry in `BUILT_IN_DRIVERS` and its `Env` union. Conflicts here every time upstream adds a driver; trivial fix. |

## Structural traps

Two upstream mechanisms silently defeat the obvious fork change. Both were found while
surveying the tree before any fork code existed.

### Migration numbering

`apps/server/src/persistence/Migrations.ts` is a statically ordered manifest. Each migration is a
`[id, name, module]` tuple in `migrationEntries`, and `Migrator.fromRecord` orders and tracks
them by integer id. Upstream currently occupies `1..53`. A fork migration that takes the next
integer collides with upstream's next migration by number, not only by text. The two would
sort into the same slot and one of them would never run on databases that already recorded that
id.

Policy: **the fork adds no migrations unless unavoidable.** The OMP provider needs none.
`provider_instance_id` (migrations `027_ProviderSessionRuntimeInstanceId` and
`028_ProjectionThreadSessionInstanceId` under `apps/server/src/persistence/Migrations/`) already
accepts any driver slug, so a new driver is pure runtime configuration.

If a fork migration ever becomes unavoidable, number it from **900** upward and say so in the
migration's header comment. Upstream will not reach 900 in the life of this fork, and the gap
makes fork migrations obvious in the manifest during a conflict.

### Model manifest

`apps/server/src/provider/ModelManifest.ts` ships a bundled `model-manifest.json` and, at
runtime, fetches `MODEL_MANIFEST_URL`
(`https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/server/src/provider/model-manifest.json`,
declared at `ModelManifest.ts:39`). The fetched file replaces the bundled manifest wholesale,
and the on-disk copy of the last successful fetch outranks the bundle on later starts. A
fork-added `providers.omp` key in the bundled `model-manifest.json` is present only until the
first successful fetch, then disappears.

Rule: **OMP discovers its models dynamically and never relies on the manifest.** Do not edit
`model-manifest.json` and do not point `MODEL_MANIFEST_URL` at the fork; that would cost every
fork user upstream's model updates.

## Proposing changes upstream

A generic fix (not OMP-specific, no fork vocabulary, shaped like an upstream PR) goes in its own
commit with an upstream-style message, separate from any fork-specific commits on the same
branch. That makes it a cherry-pick onto a clean branch cut from `upstream/main`:

```sh
git fetch upstream
git checkout -b for-upstream/<topic> upstream/main
git cherry-pick <sha>
```

Push that branch to a personal fork of `pingdotgg/t3code` and open the PR there, following
upstream's `CONTRIBUTING.md`. Keep the commit in this fork's `main` as well; git resolves the
duplicate cleanly on the next merge once upstream lands it.

## Reporting a sync

Record every merge in the pull request or commit that carries it: the `upstream/main` sha that
was merged, whether the merge was clean, and which hot files needed a hand-resolved conflict.
The first sync after this runbook was written is recorded in
[yashptel/oh-my-t3code#1](https://github.com/yashptel/oh-my-t3code/issues/1).
