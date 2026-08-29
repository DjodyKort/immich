# Self-hosted runner for the local AI routes

**Status: built and running, 2026-08-29.** This file described a plan; what exists now differs from
it in several ways, and the differences are recorded below rather than the plan being quietly
rewritten. The implementation lives in `~/argus-runner/` (compose, Dockerfile, `confine.sh`,
`ensure-runner.sh`), versioned by `immich-meta infra`.

How to make the local model routes reachable from CI.

**Correction to this document's original premise.** It opened by saying *"Both gateways bind
`127.0.0.1` on the home server, so the runner goes to them rather than the endpoints being exposed."*
Only half of that was ever true, and it misled a whole session's reasoning:

- hiro **does** bind `127.0.0.1:8130`, and has **no authentication at all** — no key handling exists
  anywhere in its code. The bind is its entire security model. hiro's own D-0038 rejected widening it
  because that "would publish an unauthenticated Claude endpoint".
- OmniRoute binds **`0.0.0.0:20128`**, deliberately, so its dashboard is reachable on the LAN without
  an SSH tunnel. `REQUIRE_API_KEY=true` is therefore load-bearing rather than belt-and-braces: it is
  the only thing between the LAN and, in its own compose file's words, *"an open inference proxy to
  every provider OmniRoute holds a key for"*.

## Read this before registering anything

**This fork is a public repository, and GitHub advises against self-hosted runners on public repos.**
The reason is concrete: workflows triggered by pull requests can run code from the pull request's
branch, so anyone able to open a PR could potentially execute code on the machine hosting the runner.
That machine is the one holding a personal Max session and a set of provider keys, which makes it a
bad place to lose that argument.

This setup is only safe with all three of the following. Check them before the runner exists, not
after:

1. **No `pull_request`-triggered job may ever run on the self-hosted runner.** Today that holds:
   `fork-ci.yml` is entirely `ubuntu-latest`. The only jobs that can land on the self-hosted runner are
   argus's `route.yml` probe and `task.yml` run job, reached from `upstream-sync.yml`, which triggers on
   `schedule` and `workflow_dispatch` only. Keep it that way. A single `runs-on: self-hosted` added to a
   `pull_request` job undoes everything here.
2. **Require approval for all outside collaborators.** Settings → Actions → General → "Fork pull
   request workflows from outside collaborators" → *Require approval for all outside collaborators*.
   The default only gates first-time contributors.
3. **Treat the runner as disposable.** Give it its own unprivileged user and no access to anything the
   triage does not need. It needs exactly two things: outbound HTTPS to GitHub, and `curl` to
   `127.0.0.1`.

   **What that sentence actually cost to implement.** A bare `useradd ghrunner` does not deliver it,
   and this box has no host firewall to make up the difference — before 2026-08-29, `nft list ruleset`
   showed **zero chains hooking input**. So the runner is an ephemeral container on its own bridge
   network, reaching hiro through a socat sidecar and nothing else. Three corrections were needed,
   each found by measuring rather than reasoning:

   - The sidecar could not bind the bridge gateway address, because compose does not materialise a
     network that nothing attaches to and the sidecar runs on the host network. `argus_net` is
     external and created by `ensure-runner.sh`.
   - It could not bind `20128`, because OmniRoute's `0.0.0.0` already owns that port on every
     interface. OmniRoute is forwarded on **20129** instead, which also stops the runner depending on
     a bind decision recorded in another project's compose file.
   - The sidecar alone confined nothing. A container reaches the host's own LAN address freely, and
     that traffic lands on the **input** hook, which `DOCKER-USER` (a forward chain) never sees —
     while anything published by a container is DNAT'd and lands on **forward**. Measured before the
     fix: the runner could reach ollama, gitea, immich, grafana and nha. It took a chain on each hook.

   Verified after: the two gateway ports and GitHub are reachable; every RFC1918 destination is not.

If any of those feels like too much, the honest alternative is to skip the local routes and let the
metered `api` route be the only model route. Route selection already handles that: it reports
`none` or `api` and nothing breaks.

## Register the runner

On `192.168.1.21`, as a dedicated user rather than root:

```bash
sudo useradd -m -s /bin/bash ghrunner
sudo -iu ghrunner
mkdir -p ~/actions-runner && cd ~/actions-runner
# Latest release: https://github.com/actions/runner/releases
curl -o runner.tar.gz -L https://github.com/actions/runner/releases/download/v2.XXX.X/actions-runner-linux-x64-2.XXX.X.tar.gz
tar xzf runner.tar.gz
```

Get a registration token from Settings → Actions → Runners → New self-hosted runner, then:

```bash
./config.sh --url https://github.com/DjodyKort/immich \
            --token <REGISTRATION_TOKEN> \
            --name hiro-box \
            --labels argus \
            --unattended \
            --replace
```

The label **must** be `argus`: that is the default `runner_label` in argus's `route.yml`, and nothing in
this repo overrides it.

Install it as a service so it survives reboots:

```bash
sudo ./svc.sh install ghrunner
sudo ./svc.sh start
sudo ./svc.sh status
```

## What the runner does not hold

The registration token is minted host-side, per start, by `ensure-runner.sh`. It is valid for an hour
and an `--ephemeral` runner exits after every job, so the obvious alternative is to give the runner a
PAT and let it mint its own. That is the wrong trade: the runner is the one component here that
executes code from a public repository, and a token that can register runners is precisely what should
not be sitting on it. The host already holds `gh` credentials for other reasons.

A systemd timer (`argus-runner.timer`, every 5 minutes) mints a fresh token and brings the runner back
after each job, then re-applies the confinement. The runner's compose entry is `restart: 'no'` on
purpose — a restart policy would loop it against a stale token.

## The status token

Listing runners needs `administration: read`, which `GITHUB_TOKEN` cannot be granted, so route
selection needs a fine-grained PAT. Without it selection simply treats the local routes as
unavailable, which is a safe default but means the local routes never get used.

Create a fine-grained PAT scoped to **only** `DjodyKort/immich`, with:

- Repository permissions → **Administration: Read-only**

Nothing else. Store it as the repository secret `RUNNER_STATUS_TOKEN`.

## The sync token

`upstream-sync.yml` pushes the merge branch, and `GITHUB_TOKEN` is **not permitted to create or update
anything under `.github/workflows`**. There is no `workflows` permission a workflow can grant itself, so
no `permissions:` block fixes it, and upstream edits its own workflows often enough that this is the
normal case rather than an edge one. Without a usable token the workflow stops before pushing and says
so in the run summary.

So the push uses an optional `SYNC_TOKEN` secret. A fine-grained PAT scoped to **only**
`DjodyKort/immich`, with:

- Repository permissions → **Contents: read and write**
- Repository permissions → **Workflows: read and write**

Nothing else. Fine-grained PATs must carry an expiry, so this will lapse; when it does the push fails
loudly rather than silently, which is the acceptable failure mode.

**What is in there today is not that.** It currently holds the `gh` CLI's own OAuth token, which carries
`repo` across every repository on the account plus `gist`. That works, and it was the only thing
available without a browser, but it is far more privilege than this needs, and a repository secret is
readable by any workflow in the repository. Replacing it is a drop-in swap: same secret name, no
workflow changes.

**The better answer, when tokens become tiresome:** a GitHub App installed on the fork with those same
two permissions, minting a one-hour installation token per run via `actions/create-github-app-token`.
No long-lived usable credential in secrets, no expiry treadmill, not tied to a personal account, and it
can absorb `RUNNER_STATUS_TOKEN` as well so the repo holds no PATs at all. This is what upstream itself
does, via `immich-app/devtools/actions/create-workflow-token` and its `PUSH_O_MATIC_APP_*` secrets.

An **org secret is not an option** here: org secrets are only readable by repositories inside the org,
and this is a personal repository. It would also put a work-org credential behind personal-fork pushes,
which is the boundary hiro's own rule about work seats exists to keep.

## Verify

```bash
gh workflow run "Upstream sync" --repo DjodyKort/immich --ref integration
```

Then read the `Decide` job nested inside Triage. Expected progression as pieces land:

| State | Expected `route` |
|---|---|
| Nothing set up | `none` |
| `ANTHROPIC_API_KEY` set, no runner | `api` |
| Runner online, `RUNNER_STATUS_TOKEN` set, hiro-bridge running | `local-primary` |
| Runner online, hiro-bridge down or refusing, OmniRoute running | `local-fallback` |

The probe treats any HTTP response as alive, including 401 and 404, because it is a liveness check
rather than an auth check. A closed port answers `000`, which is the case being distinguished.

## OmniRoute, if you want route 2

Self-hosted, MIT, one OpenAI-compatible endpoint over many providers, with its own internal fallback
across them. Default port 20128, which is what the probe expects:

```bash
docker run -d --name omniroute --restart unless-stopped \
  -p 127.0.0.1:20128:20128 \
  -v /opt/omniroute:/data \
  diegosouzapw/omniroute
```

Bind it to `127.0.0.1`, not `0.0.0.0`: the runner reaches it locally, and nothing else should.

Leave its prompt compression **Off or Lite**. The higher settings are lossy, and a diff being audited
for correctness is the wrong thing to compress.

## What is still unverified

`hiro`'s own tracker lists "confirm included-usage billing" as blocked on a quota reset, so the claim
that this route draws included rather than metered usage is not yet proven. Before trusting it, check
hiro's predicate on a real turn:

```
status ∈ {allowed, allowed_warning}
  ∧ rate_limit_type ∈ {five_hour, seven_day, seven_day_opus, seven_day_sonnet}
  ∧ raw.isUsingOverage is False
  ∧ billed tokens > 0
```

And remember the quota engine stops autonomous work at 90% of included headroom by design. CI triage
is autonomous work, so hiro refusing a turn is normal operation; that is what the fallback gateway is for.
