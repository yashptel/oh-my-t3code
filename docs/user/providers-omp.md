# Oh My Pi

Install Oh My Pi (`omp`) on the machine running your environment and sign in to
your model providers there, then enable **Oh My Pi** in **Settings > Providers**. See
[provider setup](./install.md#providers). T3 Code talks to `omp acp` and uses the
credentials already configured under `~/.omp`; there is nothing to sign in to inside
T3 Code.

If `omp` is not on the environment's `PATH`, set **Binary path** in provider
settings. **Launch arguments** are appended to `omp acp` when a thread starts.

## Models and thinking

The model list is what `omp models` reports on that machine. **OMP default model**
keeps whatever default Oh My Pi is configured with, so the same thread follows your
`omp` configuration. Picking any other model applies to the current thread only and
does not change Oh My Pi's saved defaults.

Models that support reasoning offer a **Thinking** level in the composer, using the
levels Oh My Pi lists for that model. Non-reasoning models show no thinking option.

After changing `omp` logins or model configuration, use **Refresh provider status**
in **Settings > Providers**.

## Approvals

Oh My Pi follows the shared [permission modes](./permission-modes.md). Tool
approvals arrive as ordinary approval requests in the thread. **Always allow this
session** uses Oh My Pi's own "always allow" option when it offers one for that
tool. **Full access** approves requests automatically. **Auto** falls back to asking,
as with OpenCode and Antigravity.

Oh My Pi does not ask free-form questions over this connection; the agent decides on
its own where another provider would ask.

Each thread is one Oh My Pi session, stored under `~/.omp/agent/sessions`.
Reopening a thread resumes that session. Stopping a turn cancels it in Oh My Pi and
the thread stays usable. Commit messages, PR text, branch names, and thread titles
generated with Oh My Pi run through `omp -p` without saving a session.
