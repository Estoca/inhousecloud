# Publish your first app

Tell Claude what your team needs, check the result, then ask it to publish the
app on your company cloud. You do not need to write the code yourself.

## Before you start

Your company cloud must be installed and you must be able to open its portal.
For managed hosting, finish the company and hosting setup in inhouse.technology
first. Sign in with Google Workspace; Microsoft sign-in is experimental, and
personal Gmail accounts cannot get in.

Use Claude Code with access to the app's code and this repository's instructions.
For a new app, the coding agent needs access to the cloud's server. For an app
already on your laptop, it can [publish by Git push](gitops-flow.md#from-a-laptop)
using your own Gitea access, without server access. Keep passwords, tokens and
keys out of the conversation.

The downloadable skills are Portuguese first. Replies follow your language.

## What to ask Claude

For example:

> Build an internal expense log for our company. Each person should see their
> own expenses; admins should see all of them. Include a date, amount, description
> and a monthly total. Use our company sign-in. Show me the app, then publish it
> on our InHouseCloud when I approve it. Call it expense-log. Ask who should own it.

Describe who will use it, what they need to do and who may see each person's
data. Give the agent your portal address and the app owner's company email.
An app behind company sign-in still needs to enforce those data permissions.

## What the agents and deploy loop do

The coding agent checks the cloud, chooses an available app name, creates a
repository from the app template and writes your app. It uses the cloud's shared
database and Redis rather than installing separate services for the app.

When you approve publishing, it pushes the code to `main` in the company's Git
service, Gitea. The cloud's deploy job builds a release, provisions the app's
database and credentials, sets up its address and company sign-in, starts the
app and checks its health. It records the deploy so the operator can inspect
what changed. Later pushes to `main` repeat this loop.

The operator agent handles questions such as "why is it down?" and "is the backup
working?" It reads the cloud's health and logs before proposing a change and
asks before actions that need your approval. The optional operator agent is
separate from the coding agent; publishing runs through the deploy job even
without it. See the [deploy loop](deploy-loop.md) and [operator contract](operator-contract.md).

## Where to find it

Open your company portal at `https://portal.<BASE_DOMAIN>`. The catalog shows the
app and its health. Your app opens at `https://expense-log.<BASE_DOMAIN>` behind
company sign-in. Use the base domain from your cloud's handoff; a local trial
uses HTTP, for example `http://expense-log.cloud.localhost`.

Ask Claude to confirm that the deploy for your commit succeeded, then open the
app and try it as an ordinary team member. A health check alone does not prove
that the screens or data permissions work.

For a change, ask Claude to update the app and publish it again. If a release is
broken, the operator can review its deploy journal and roll back to the previous
release when one is available. A rollback does not undo database migrations.

## How to remove it

Ask the person operating your cloud to retire the app. Name the app and agree
what data and source code to keep, verify a backup, then review the removal plan.
Removing a real app is manual today: the operator stops its containers and
removes its route, sign-in configuration, repository, data resources and catalog
entry. Keep its deploy journal with the backup. The details are in
[Remove one app](cleanup.md#remove-one-app).

`ihc-app remove` only removes apps created by system tests. Deleting code or
removing a portal entry alone does not remove a deployed app. Do not use
`install.sh remove` for this: it removes the whole cloud.
