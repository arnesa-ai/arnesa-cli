# arnesa

The command line client for Arnesa, the independent benchmark for AI coding-agent harnesses. Point it at your Arnesa deployment with `--api <url>` or the `ARNESA_API_URL` environment variable.

```sh
npx arnesa detect      # print the profile of this project (nothing leaves your machine)
npx arnesa recommend   # ask Arnesa which verified harnesses fit this profile
npx arnesa install <slug>
npx arnesa remove <slug>
npx arnesa doctor      # scan your agent configuration files
npx arnesa login       # sign in with a device code
```

Requires Node.js 22 or newer.

## What leaves your machine

- `detect` sends nothing.
- `recommend` and `install` send a closed-vocabulary profile (languages, frameworks, runtimes), never file names or contents.
- `doctor` lists the agent configuration files it would upload, asks first, and uploads only those. It never uploads source code, `.env` files or credential files. Uploaded files are deleted after the scan, within one hour at most.
- Your token is kept in the operating system keychain, never in a file.

## Safety of `install`

The server response is treated as untrusted. Files are written only inside the allowed agent directories, after a preview and a confirmation. Every write is backed up under `.arnesa/backups/`, and `arnesa remove` restores the project. Use `--yes` to confirm files and `--allow <gate-id>` for a command that runs on its own.

## Exit codes

| Code | Meaning               |
| ---- | --------------------- |
| 0    | Success               |
| 1    | Failure               |
| 2    | Usage error           |
| 3    | Confirmation required |
| 4    | Refused by policy     |
| 5    | Rate limited          |

Add `--json` for one JSON document on stdout.

## Limits

Working defaults, effective 2026-11-06, confirmed by the founder on 2026-11-07 (Open Question 1, design decision 6 of `add-arnesa-local-cli`). They can change, and the server answers with exit code 5 when one is reached.

| Caller                            | `recommend`       | `compile` (install) |
| --------------------------------- | ----------------- | ------------------- |
| Anonymous                         | 10 per 10 minutes | 5 per 10 minutes    |
| API key (`ak_`) or device (`ad_`) | 200 per day       | 50 per day          |

Upload caps for `doctor`: 200 files, 256 KiB per file, 1 MiB in all.

## Licence and trademark

The code is released under the MIT licence (see `LICENSE`). The Arnesa name and logo are not part of that licence: you may not use them to suggest that a fork or a derived product is Arnesa or is endorsed by Arnesa.
