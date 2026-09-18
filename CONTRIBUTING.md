# Contributing

`oh-my-t3code` is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) whose goal
is to be the best GUI for stock Oh My Pi. Contributions are welcome. The constraint that shapes
every one of them is that the fork merges upstream regularly, so a change has to survive that
merge.

## Developer Setup

See the [development runbook](docs/operations/development.md#first-checkout) for the initial
checkout, development commands, tests, and platform-specific desktop packaging prerequisites.

Add the upstream remote once per clone. The
[upstream sync runbook](docs/operations/upstream-sync.md) covers the remote, the branch model,
the merge procedure, and the files to stay out of.

## Two kinds of change

**OMP work** is anything that exists because of Oh My Pi: the provider driver, its runtime layer,
its user guide. It lives in files upstream does not have, listed in
[Where fork code lives](docs/operations/upstream-sync.md#where-fork-code-lives). Touching an
upstream-owned file for OMP work is limited to the one-line registrations in the
[hot files table](docs/operations/upstream-sync.md#hot-files).

**Generic work** is a fix or improvement that has nothing to do with OMP and would be accepted
upstream as written. Put it in its own commit with no fork vocabulary so it can be cherry-picked
onto a clean `upstream/main` branch. See
[Proposing changes upstream](docs/operations/upstream-sync.md#proposing-changes-upstream).

A change that is neither (a product feature that only makes sense in this fork but lives in
shared UI, for example) needs an issue first so we can agree on the smallest upstream footprint.

## Before you write code

Read the two [structural traps](docs/operations/upstream-sync.md#structural-traps). The fork
adds no database migrations, and the OMP provider never reads the model manifest. Both rules
come from upstream mechanisms that silently discard the obvious fork change.

Read [`AGENTS.md`](AGENTS.md). Its guidance on performance, surfaces, documentation, and
verification applies here unchanged.

## Opening a PR

One issue per branch, one concern per PR. Conventional commit titles in plain language, as in
`feat(provider): register the OMP driver`.

With the GitHub CLI, always pass the repository explicitly:
`gh pr create --repo yashptel/oh-my-t3code`. This repository is a registered GitHub fork, so
without `--repo` the CLI targets `pingdotgg/t3code` and fails with "Head sha can't be blank".

Explain what changed and why. State which hot files the PR touches, if any, and why the touch
could not be avoided.

Follow the [documentation rules](AGENTS.md#documentation). Internal docs are for decisions and
hard-to-discover constraints. User guides change when how to use a feature changes.

UI changes include before/after images. Motion or timing changes include a short video.

Docs-only PRs that document a procedure include the real output of running it once.

## Reporting bugs

Bugs in generic T3 Code behavior that reproduce on upstream belong in
[upstream's issue tracker](https://github.com/pingdotgg/t3code/issues). Bugs in OMP behavior, or
in the fork's own merges, belong here.
