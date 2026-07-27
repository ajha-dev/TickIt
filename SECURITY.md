# Security

## The threat model, stated plainly

**TickIt has no authentication, and that is deliberate.** It is built to run on
a private network — a tailnet, a VPN, a LAN behind a firewall — where the
network is the security boundary. The reasoning is in `PLAN.md`: a login screen
between a thumb and a 3am feed is a real cost, and on a single-user private
network it buys nothing.

The consequence is not subtle: **anyone who can reach the port can read and
write everything.** There are no accounts, no sessions, no per-user data
separation, and no audit log beyond an "edited" marker on individual events.

**Do not expose an instance to the public internet as-is.** If you need to,
add authentication in the same change — not as a follow-up.

This also means the app may hold health data (feeds, medication, symptoms) with
no access control of its own. Treat the host accordingly: disk encryption,
private backups, and a bucket that is not world-readable if you enable
Litestream.

## What is in scope

Bugs that break the model above, rather than the model itself:

- Path traversal, SSRF, injection, or anything letting a request read or write
  outside its intended scope
- A way to reach the API that bypasses whatever network boundary the operator
  put in front of it
- Secrets leaking into logs, error responses, the built client bundle, or the
  published container image
- Dependency vulnerabilities that are actually reachable in shipped code —
  the runtime dependencies, not the build tooling

## What is not in scope

- "There is no login." That is documented above and is the design.
- Advisories in dev-only dependencies (`vite`, `esbuild`, `workbox`,
  `drizzle-kit`). They do not ship in the image. CI reports them without
  blocking, deliberately.
- Anything requiring an attacker to already be on the operator's private
  network — that is the trust boundary, not a vulnerability in it.

## Reporting

Open a **private security advisory** through GitHub:
**Security → Advisories → Report a vulnerability**. That keeps the report
private until a fix exists.

Please do not open a public issue for something exploitable.

This is a personal project maintained in spare time. There is no SLA. Expect a
reply within a couple of weeks, and be aware that a fix may simply be a
documentation change if the behaviour turns out to be intended.

## What is automated

- **gitleaks** over full history on every push and weekly
- **CodeQL** (`security-extended`) on public checkouts
- **Dependency review** blocking new high-severity dependencies on pull requests
- **npm audit** reporting, not blocking — see above for why

Details and the reasoning behind each choice are in
`.github/workflows/security.yml`.
