# Vision Router doctor / repair

Vision Router ships a small standalone diagnostic CLI. It does not need DSH to boot first, so it can still run when DSH exits while parsing a broken profile manifest or when an older Vision Router build left one conversation unable to cold-resume.

## Normal installation stays unchanged

Use DSH's own plugin command:

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-vision-router
npx @deepseek-ai/dsh web
```

For a DeepSeek Harness source checkout:

```sh
pnpm dsh plugin --profile web add dsh-vision-router
pnpm dsh web
```

The doctor is a recovery/diagnostic tool, not a replacement installer.

## Diagnose profiles

```sh
npx dsh-vision-router doctor
```

To inspect only the Web profile:

```sh
npx dsh-vision-router doctor --profile web
```

The command locates the DSH home (`$DSH_HOME` when set, otherwise `~/.dsh`), scans profile `package.json` files, reports UTF-8 BOM bytes, validates the JSON after ignoring a leading BOM for diagnosis, reports whether `dsh-vision-router` is present as a profile dependency and bundle layer, and flags version-pinned `minimumReleaseAgeExclude` entries in the profile's `pnpm-workspace.yaml` that would hold back the next release.

## Repair the UTF-8 BOM startup failure

If DSH fails before plugins can load with an error such as:

```text
SyntaxError: Unexpected token ... is not valid JSON
at readProfileManifest (.../profile.ts:...)
```

run:

```sh
npx dsh-vision-router repair --profile web
```

`repair` removes only the three-byte UTF-8 BOM prefix (`EF BB BF`) when it is present, then validates the remaining JSON. It does not reformat, regenerate, or otherwise rewrite the profile contents. If JSON is still invalid for another reason, the command reports that and stops rather than guessing a repair.

## Repair a stale release-age exemption (the "update does nothing" gate)

pnpm v11 defaults `minimumReleaseAge` to 1440 minutes: a version published less than 24 hours ago is not resolved, so `dsh plugin update` silently keeps the previous version and prints `downloaded 0 / added 0`. An exemption entry that pins a version — `dsh-vision-router@1.2.0` — only exempts that one version and goes stale on the next release, which is why "a new release is out but the update does nothing" keeps recurring.

The doctor flags version-pinned entries for `dsh-vision-router` and the `@deepseek-ai/*` host packages:

```text
✗ web — … — release-age exemption version-pinned (dsh-vision-router@1.2.0) — releases younger than 24h will not be picked up
```

Run:

```sh
npx dsh-vision-router repair --profile web
```

to rewrite them to bare names (`dsh-vision-router`, `@deepseek-ai/*`), which exempt every future version, so upgrades take effect immediately again. Unrelated entries and the rest of the file are left untouched.

## Repair a conversation that only breaks after restarting DSH

A very early Vision Router build briefly persisted the automatic vision-tool mount reminder as a `user/message` without a message `id`. The conversation could keep working in the live process, but after DSH restarted the stricter cold-resume validator could reject that stored event with an error containing:

```text
lacks an identified message
```

Current Vision Router builds no longer create that malformed event. To recover an already-affected conversation, **stop DSH first**, then run:

```sh
npx dsh-vision-router repair-sessions
```

The repair is intentionally narrow and fail-closed:

- it scans `$DSH_HOME/sessions` for the exact historical Vision Router auto-mount reminder signature only;
- unrelated malformed messages are not changed;
- both raw `session.jsonl` and DSH's default checksummed `session.jsonl.zstd` format are supported;
- unchanged Zstandard frames stay byte-for-byte identical;
- torn/incomplete logs are refused so DSH can perform its own crash recovery first;
- the source file identity is checked again immediately before replacement, so a live writer causes the operation to abort instead of racing;
- every changed log receives a byte-for-byte backup next to the original before replacement, and the repaired log is re-read and verified before success is reported.

After the command reports a repaired session, restart DSH and reopen the conversation. Running `repair-sessions` again is idempotent: already-repaired logs are left untouched.
