## What and why

<!-- One subject per pull request. What it changes, and why. -->

## How it was tested

<!-- The commands you ran and what they printed: npm test, scripts/tests/*.sh, a clean VM install (docs/try-it.md), the smoke test counts. Say what was not covered. -->

## Checklist

- [ ] Tests: `npm ci && npm test && npm run build` in `portal/` and `scripts/tests/*.sh` pass; a test covers the change where one fits
- [ ] Installer, deploy job or portal touched: run on a clean box, and a record added to `docs/first-run.md`
- [ ] Sweep: no secret, real company, person, domain, IP address or local path in the diff (`git diff main...`), commit messages included
- [ ] New variables are in the matching `.env.example`, with a placeholder
- [ ] Docs updated (README, AGENTS.md, the contracts in `docs/`, the runbooks) where a person or an agent will look

## Steps for the maintainer

<!-- Anything to do outside the code before or after the merge: a GitHub setting, a re-run, an announcement. "None" if none. -->
