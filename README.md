# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Arcazero/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Arcazero/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit an AI model wrote to a tree of text files — one patch
tool for every AI edit format: unified diffs, SEARCH/REPLACE blocks, V4A
patches and JSON tool calls. Every file is changed or nothing is: edits
apply in order, a failed edit is reported and rolled back, and no file is
written unless every edit succeeded. Matching is fuzzy across three tiers
(exact, trailing whitespace, then leading and trailing whitespace), with
`--strict` for exact matches only and `--check` for a dry run.

## Run it

```sh
node main.ts patch.diff
```

Reads the patch from the file given, or from standard input when the file
is `-` or absent. `--format=unified|search-replace|v4a|json` forces one
format; the default `auto` detects it. See SPEC.md for the full
specification.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ackjrmv3&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
