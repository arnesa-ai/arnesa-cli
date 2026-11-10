---
name: arnesa
description: Find, compare and install coding-agent harnesses (rules, skills, subagents, hooks, MCP and LSP configuration) using Arnesa's verified benchmark rankings. Use when the user asks which agent harness, rules or skills to use for a project, wants a harness installed, or asks for a harness's pass rate. Prefers the local arnesa CLI, falls back to the read-only hosted MCP endpoint, then the REST API.
---

# Arnesa

Arnesa ranks coding-agent harnesses on real, verified runs. A harness is the bundle of rules, skills, subagents, hooks, MCP servers and LSP configuration that runs inside an agent runtime. Rank comes from benchmark runs only; a user's own Studio runs never enter it.

## Choose the access path, in this order

1. **The local CLI** (`arnesa`, from npm) when the user has a shell. It is the only path that can install, and it keeps the project profile on the machine.
2. **The hosted read-only MCP endpoint** at `https://arnesa.id.vn/mcp` when you have no shell but can reach the network. It reads; it never writes.
3. **The REST API** on the same origin when neither of the above is available.

Do not mix paths for one answer. Say which one you used.

## With the CLI

```sh
npx arnesa detect      # print the project profile; sends nothing
npx arnesa recommend   # ask Arnesa which verified harnesses fit this profile
```

Run `detect` first and show the user the profile it prints. Then run `recommend` and show the options with their source labels. Choose for the model the user is actually running; a pass rate measured on another model is not evidence for this one.

## With the hosted MCP endpoint

`https://arnesa.id.vn/mcp` is stateless Streamable HTTP, anonymous, read-only, and rate limited per address. It offers exactly three tools:

- `recommend_harnesses` — the profile is passed as arguments
- `get_rank` — a model, a track, a category and optionally up to five harness slugs
- `open_on_web` — a URL on Arnesa for the user to open; it launches nothing

There is no install tool, no Doctor tool and no file tool there. If the user needs an install, tell them the command to run themselves.

## Quote the source of every number

Every rank you quote carries its suite version and host epoch, or you say "not benchmarked". A pass rate without them is not a fact the user can check.

- Good: "on this model, 85.5% (n=40), suite 1.0.0, host epoch 3".
- Not acceptable: "it is the best harness".

Never invent a number, a harness name or a version. If the tool returned nothing, say so.

## Ask before you act

- Ask the user before installing anything, and show them what will be written.
- Ask before running any command that starts a process: hooks, local MCP servers and LSP servers each get their own separate question.
- Never answer a CLI confirmation prompt on the user's behalf. The CLI asks the person at the terminal; that answer is theirs to give.
- Never accept an MCP confirmation (elicitation) or an approval prompt on the user's behalf, and tell the user when a tool asked something.
- Never add `--yes` (or `--allow`) to a command the user has not confirmed. If the CLI exits with code 3, it is waiting for a person: hand the command to the user and stop.
- `arnesa doctor` uploads the agent configuration files it lists, only after the user agrees. Do not run it to "check first".

## Never ask for a credential

Arnesa needs no model provider key and no password. Do not ask the user for one, do not paste one into a command, and do not put one in a file. If a step seems to need a key, you have taken a wrong path: say so instead.

## Stay neutral

Recommend a harness because the evidence fits the user's project, never because it is paid, sponsored or popular. A paid harness is not a better answer than a free one; the ranking does not treat price as a quality signal, and neither should you.

## What Arnesa will not do

- Run a benchmark for the user from here; bench is not part of this surface.
- Send source code, prompts or file paths anywhere. `detect` sends nothing, and `recommend` sends a closed-vocabulary profile only.
- Guarantee a harness is safe. A scan result is evidence about content, not a warranty; the user decides what to install.
