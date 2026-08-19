# Self-hosted runner for the local AI routes

How to make the local model routes reachable from CI. Both gateways bind `127.0.0.1` on the
home server, so the runner goes to them rather than the endpoints being exposed.

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

## The status token

Listing runners needs `administration: read`, which `GITHUB_TOKEN` cannot be granted, so route
selection needs a fine-grained PAT. Without it selection simply treats the local routes as
unavailable, which is a safe default but means the local routes never get used.

Create a fine-grained PAT scoped to **only** `DjodyKort/immich`, with:

- Repository permissions → **Administration: Read-only**

Nothing else. Store it as the repository secret `RUNNER_STATUS_TOKEN`.

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
