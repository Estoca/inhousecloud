# Chat Deploy Contract

**Status: proposed (2026-11-06), not implemented.** This page is the contract the
implementation will follow; nothing below exists in the gateway yet. Schema:
[`schemas/chat-deploy.schema.json`](../schemas/chat-deploy.schema.json), with valid and
invalid examples in [`schemas/examples/chat-deploy/`](../schemas/examples/chat-deploy/)
checked by `portal/test/chat-deploy-contract.test.js`.

## Why

Today an app reaches the cloud by `git push` to `main` ([GitOps flow](gitops-flow.md)):
the agent needs a shell, `git` and the person's Gitea token. Claude Code and Codex have
that. The chat in claude.ai does not: its sandbox cannot reach the box over SSH, its
network egress is restricted, and the only door it has to the company is the
[MCP gateway](mcp-gateway.md) (directly, or through inhouse.technology's `ihc_call`).

The goal is that a person can say, in the chat, "build an app for our purchase requests",
and get back a link behind the company sign-in, with the agent fixing its own mistakes
in between, and a human approving only the step that puts something on the air.

## The loop

```text
ihc_app_spec        what the cloud expects: stack, manifest, variables, rules, limits, template
      │             (and, for an app that exists, its head commit and files)
      ▼
agent writes the app in its own sandbox
      │
      ▼
ihc_app_check       the files go up; lint, build, migrate and start run in a throwaway
      │             area on the box; nothing goes on the air; no approval needed
      ▼
ihc_deploy_status   poll until a terminal state; read the findings; fix; check again
      │             (repeat until "passed")
      ▼
ihc_app_deploy      write, needs confirmed_by: the checked candidate becomes a commit on
      │             main of the app's repository, and the usual deploy runs
      ▼
ihc_deploy_status   poll until "healthy" (the URL) or "unhealthy" (findings, rollback)
```

Four tools, not three: splitting `check` from `deploy` is what lets the agent iterate
without asking a person to approve every attempt. Only `ihc_app_deploy` changes what
people use, and only it needs a human.

The deploy itself is not new. `ihc_app_deploy` ends in a commit on `main`, and from
there it is the same build, apply, journal and rollback as a `git push`
([the deploy job](gitops-flow.md#3-what-the-deploy-job-does)). Git stays the record of
what runs; the chat is another way to write to it.

## Tools

All four are platform tools of the gateway (`ihc_*`), listed for `ihc-users`. Through
inhouse.technology they are called as `ihc_call(tool, arguments)`. Inputs and outputs
are the `$defs` of the schema named in each heading.

### `ihc_app_spec` (read) — `AppSpecInput` → `AppSpecOutput`

| Input | Meaning |
|---|---|
| `slug` | optional. An existing app: adds `app` (head commit and file list) to the answer. A slug not in use: says so, and the answer is for a new app |
| `include` | optional list: `template` (the starter files, inline), `source` (a signed download link for the app's current tree, 5 minutes), `upload` (a signed upload link for a large tree, see [Files](#files)) |
| `start_from` | reserved for the app catalog (later); refused today |

The answer carries `spec_version`, the stack the cloud runs (`docker-compose`, the
recommended starter images), the manifest's schema and a minimal valid example, the
variables the app receives (`PORT`, `DATABASE_URL`, `DATA_DIR`, `X-authentik-email`
and the rest of [what the app receives](app-contract.md#what-the-app-receives)), the
rules as `{code, text}` (the same codes as [findings](#findings)), the limits of this
contract, the stages a check runs, and who may deploy (below). It is the agent's single
source: it should not need to read this page.

### `ihc_app_check` (read, rate-limited) — `AppCheckInput` → `JobAccepted`

| Input | Meaning |
|---|---|
| `slug` | the app; must pass the [slug rules](app-contract.md) |
| `base_commit` | the head of `main` the agent started from (`app.head_commit` from the spec), or `null` for a new app |
| `tree` | `full` (the files are the whole app) or `changes` (applied over `base_commit`; requires it) |
| `files` | `[{path, content, encoding}]`, `encoding` `utf8` (default) or `base64` |
| `delete` | paths to remove, only with `tree: changes` |
| `upload_id` | instead of `files`: a tree sent to the upload link |

It returns at once with a `job_id`, `candidate_id` and `poll_after_seconds`. The
candidate is the exact tree that was checked, addressed by the sha256 of its content.

What runs, in order, each a [stage](#stages): the manifest against the schema and the
slug; the [trust boundary lint](app-contract.md#lint-before-build); a secrets scan of
the tree; the build (`ihc-app build` rules: no build secrets, no host network, nothing
outside the repository); the app started on an isolated network with a throwaway
database and Redis prefix, its migrations run on start; the healthcheck; and the
sign-in check (the app reads the person from the header and does not serve anonymous
content when `auth.required`). Nothing gets a route, an Authentik application, a
database on the shared Postgres or an inventory record.

Why it needs no `confirmed_by`: it changes nothing a person uses. It is still recorded
in the audit log (status `check`), and limited per person: one check running at a time,
and `IHC_CHAT_CHECKS_PER_HOUR` (default 30).

**Precondition for implementing it:** a check builds and starts code nobody has
reviewed, so it must not run where a job is root on the box. It depends on the
roadmap item [deploy jobs without the Docker socket](roadmap.md#next): an unprivileged
builder and a runtime with no access to the install directory.

### `ihc_app_deploy` (write) — `AppDeployInput` → `JobAccepted`

| Input | Meaning |
|---|---|
| `slug` | the app |
| `candidate_id` | a candidate whose check `passed` and has not expired |
| `base_commit` | the same base the candidate was checked against (`null` for a new app) |
| `message` | the commit message, one line, what changed in the person's words |
| `confirmed_by` | the person who approved, as for every [write](mcp-gateway.md#writes) |

The gateway resolves `confirmed_by` in the directory and records `requested`, as for
any write. Then:

- **New app** (`base_commit: null`): creates the private repository `<org>/<slug>`
  with Actions on (as `ihc-app new` does) and commits the candidate's tree, plus the
  template's deploy workflow when the tree does not bring one.
- **Existing app:** commits the candidate on `main` only if the head of `main` is still
  `base_commit`; otherwise refuses with `IHC-DEPLOY-STALE-BASE` and nothing changes.
  Someone else's push in between is never overwritten.

The commit is made by the gateway's deploy account, with the trailers
`Requested-by: <caller>`, `Confirmed-by: <approver>` and `Candidate: <candidate_id>`.
The audit record's `previous` and `new` are the head commits.

Who may deploy, checked for both the caller and `confirmed_by`:

- an existing app: the same people who may push to its `main` in Gitea (the rule of
  [Push to main](gitops-flow.md#2-push-to-main) does not change because the door did);
- a new app: `IHC_CHAT_NEW_APP_GROUP`, by default `ihc-admins`, since a new app is a new
  address, a new database and a new entry in everyone's catalog.

It answers with `job_id`, `commit` and the state of the deploy run.

### `ihc_deploy_status` (read) — `DeployStatusInput` → `DeployStatusOutput`

`job_id`, or `slug` for that app's latest job. The answer: `kind` (`check` or `deploy`),
`state`, the [stages](#stages) with their state and duration, the [findings](#findings),
a one-sentence `summary` for the agent to repeat, and, when they exist, `url`,
`commit`, `release`, `rollback_available` and a link to the run's log in Gitea.

| State | Terminal | Meaning |
|---|---|---|
| `queued`, `running` | no | poll again after `poll_after_seconds` |
| `passed` | yes | a check with no `error` finding; its candidate may be deployed for 24 hours |
| `failed` | yes | a check or a deploy build with at least one `error` finding |
| `healthy` | yes | a deploy on the air; `url` is the address behind the company sign-in |
| `unhealthy` | yes | a deploy that started and failed its health or sign-in check; the previous release can be restored (`rollback_available`) |
| `superseded` | yes | a newer push to `main` won; nothing of this job went on the air |
| `refused` | yes | stopped before doing anything (permission, stale base, expired candidate) |

A gateway tool call lasts at most 30 seconds, so check and deploy never wait for the
result: the agent polls. An MCP App card in the chat (live stages, the approve button,
the link) is a later presentation of the same status, not a different contract.

## Findings

What the agent reads to fix its code. Same shape in every stage (`Finding` in the
schema):

```json
{
  "code": "IHC-LINT-HOST-NETWORK",
  "stage": "lint",
  "severity": "error",
  "file": "docker-compose.yml",
  "line": 12,
  "message": "service 'app' shares a host namespace; apps must be isolated",
  "fix": "Remove network_mode: host; the app joins the ihc network and listens on PORT.",
  "docs": "https://inhouse.technology/cloud/docs/app-contract/#lint-before-build"
}
```

Rules:

- **`code` is stable.** `IHC-<STAGE>-<NAME>`, upper case. A code never changes meaning;
  a new kind of problem gets a new code. Agents and humans can search for it.
- **`severity`:** `error` stops the check or deploy; `warning` does not, and is shown so
  the agent can decide.
- **`file` and `line`** when the problem has a place; `line` is 1-based.
- **`fix`** is one instruction the agent can act on, never "see the log".
- **`log_excerpt`** only for build, start and health, at most 40 lines and 4 KB, the end
  of the log where the error is.
- **Secrets never come back.** Values of the app's env file, tokens and anything the
  secrets scan matched are replaced by `[redacted]` before the finding is stored.
- **Bounded:** at most 50 findings per job, errors first; `findings_truncated: true`
  when more were cut. Messages at most 500 characters.
- **Deterministic.** Findings come from rules and tool output, never from a model running
  on the box: whoever reviews the code is the person's own agent, with these findings and
  the rules from `ihc_app_spec`. The same tree gives the same findings up to the runtime
  stages.

### Stages

`manifest`, `lint`, `secrets`, `build`, `start`, `migrate`, `health`, `auth`, and for a
deploy also `commit` and `apply`. Each has a state `pending`, `running`, `passed`,
`failed` or `skipped` (a stage after a failed one).

### First codes

Mapped from what `ihc-app lint`, `provision` and `wait` report today, so the
implementation tags existing messages instead of inventing checks.

| Code | Stage | From today's message |
|---|---|---|
| `IHC-MANIFEST-INVALID` | manifest | the manifest fails the schema |
| `IHC-MANIFEST-SLUG` | manifest | the slug breaks the rules or differs from the argument |
| `IHC-LINT-COMPOSE-INCLUDE` | lint | `compose: include can import files outside review` |
| `IHC-LINT-COMPOSE-EXTENDS` | lint | `compose: service … uses extends` |
| `IHC-LINT-PRIVILEGES` | lint | `asks for cap_add/devices`, privileged mode |
| `IHC-LINT-HOST-NETWORK` | lint | `shares a host namespace` |
| `IHC-LINT-LIFECYCLE-HOOKS` | lint | `declares lifecycle deploy hooks` |
| `IHC-LINT-HOST-MOUNT` | lint | `host bind mount outside the app data directory` |
| `IHC-LINT-PLATFORM-PATH` | lint | `mount overlaps paths managed by install.sh` |
| `IHC-LINT-EXTERNAL-VOLUME` | lint | `uses driver_opts or external storage`, `adopts an external platform resource` |
| `IHC-LINT-OWN-DATASTORE` | lint | the compose file brings its own Postgres, Redis or S3 server |
| `IHC-LINT-BUILD-VARIABLE` | lint | `unresolved build variable` |
| `IHC-SECRETS-IN-TREE` | secrets | a credential-shaped value or a committed `.env` |
| `IHC-BUILD-CONTEXT` | build | context, Dockerfile or extra context outside the repository |
| `IHC-BUILD-FAILED` | build | `docker compose build` failed; with `log_excerpt` |
| `IHC-START-EXITED` | start | the container exited; with its last lines |
| `IHC-START-PORT` | start | nothing listens on `0.0.0.0:PORT` |
| `IHC-MIGRATE-FAILED` | migrate | the app's migrations failed on the throwaway database |
| `IHC-HEALTH-STATUS` | health | the health path answered another status, or not in time |
| `IHC-AUTH-ANONYMOUS` | auth | an anonymous `GET /` is not sent to the sign-in |
| `IHC-DEPLOY-STALE-BASE` | commit | `main` moved since `base_commit` |
| `IHC-DEPLOY-CANDIDATE-EXPIRED` | commit | the candidate is older than 24 hours or was not `passed` |
| `IHC-DEPLOY-NOT-ALLOWED` | commit | caller or approver may not push to this app, or may not create apps |

## Files

The agent sends the tree in the call when it fits, and through a link when it does not:

| Limit | Value |
|---|---|
| inline, whole call | 512 KB of `content` |
| inline, one file | 256 KB |
| files per tree | 300 |
| through `upload` | one `.tar.gz` up to 25 MB, `PUT` to the signed URL from `ihc_app_spec`, 15 minutes, single use; then `upload_id` in the check |

Paths are relative, `/`-separated, without `..`, `.git/` or absolute parts; the check
refuses anything else before it unpacks. `.env` files are refused (the cloud writes the
app's env); `.env.example` is how an app asks for a variable.

## What this contract does not cover yet

- **Preview per attempt.** A `passed` check proves the app builds, starts and answers
  with a throwaway database; it is not a URL a person can click. A preview address per
  candidate is a later step.
- **The app catalog.** `start_from` in the spec is reserved for starting from an app
  another company published; the catalog, its manifests of permissions and its licence
  are a separate design.
- **Removing an app** stays a human's job, as it is today.

## Open questions

- Whether claude.ai's sandbox may `PUT` to the company's domain (egress allowlist set by
  the organization's admin). If not, the inline limit is the real limit from the chat,
  and larger apps go through Claude Code.
- The real size limit of one tool call's arguments in claude.ai and ChatGPT, to confirm
  512 KB with a live run.
- Whether a check should also run the app's own tests when the tree declares them, and
  with which time budget.
