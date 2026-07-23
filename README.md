# difflog

Find commits using typo-tolerant `git` history search, and optionally output a single-commit or inclusive-range diff.

By default `difflog` is a **lookup tool**: it lists the commits matching your search and stops. It prints a diff or stat only when you ask for one with `-o/--output` or `-s/--stat`. Matching is token-aware and typo-tolerant — it tolerates small typos but never matches arbitrary scattered characters.

## Usage

```bash
npx difflog [options] -- <search terms>
```

## Options

```txt
-b, --body                 Include commit body in the search
-e, --exclude <path...>    Exclude one or more paths from the diff
-f, --from <start-query>   Include changes starting with the matched commit (inclusive range)
-m, --meta                 Prepend commit or range metadata to the output
-o, --output [file]        Output a full diff (stdout, or to a file)
-s, --stat                 Output a diff stat instead of the full patch
-u, --unified <lines>      Number of unified diff context lines
```

## Modes

| You pass          | Mode       | Result                                    |
| ----------------- | ---------- | ----------------------------------------- |
| _(nothing)_       | **lookup** | Lists matching commits, oldest to newest. |
| `-o` / `--output` | **diff**   | Outputs a full patch (stdout or a file).  |
| `-s` / `--stat`   | **stat**   | Outputs a diff stat (stdout or a file).   |

`--stat` chooses stat output over a full diff: a bare `-o` is redundant and prints the stat to stdout, while `-o <file>` saves the stat to that file. CLI messages are lightly colored; the diff/stat itself is always raw Git output, safe to pipe or redirect.

### Lookup (default)

Lookup lists every match in topological history order (oldest to newest, every parent before its descendants — never by fuzzy score) and never prints a diff:

```txt
4 commits matched "JIRA-123" (oldest to newest):

  1. a1b2c3d  JIRA-123 add account settings page
  2. b2c3d4e  JIRA-123 fix form validation
  3. c3d4e5f  JIRA-123 fix mobile layout
  4. d4e5f6a  JIRA-123 finalize account settings
```

If more than 10 commits match, the **oldest** 10 are shown so a newer match never hides an older one. With no match, `difflog` suggests `-b/--body`.

### Diff (`-o`)

```bash
npx difflog -o -- d4e5f6a             # full diff to stdout
npx difflog -o diff.txt -- d4e5f6a    # save to a file
npx difflog --output=diff.txt -- d4e5f6a
# Saved diff for d4e5f6a -> JIRA-123 finalize account settings to "diff.txt" (123456 bytes)
```

Saving is **atomic**: output is streamed through a temp file and renamed into place only after Git succeeds, so a failed run never leaves a partial file (stdout has no such guarantee). An empty filename (`--output=`) is rejected. Shape the diff with `-e/--exclude <path...>` and `-u/--unified <lines>`:

```bash
npx difflog -o -e package-lock.json -u 999999 -- JIRA-123 mobile
```

### Stat (`-s`)

```bash
npx difflog -s -- d4e5f6a              # stat to stdout
npx difflog -s -o stat.txt -- d4e5f6a  # stat to a file
```

### Inclusive range (`-f, --from`)

`--from <start-query>` produces an **inclusive** range diff, equivalent to `git diff A^1 B`: the positional terms resolve the ending commit `B`, and `--from` resolves the starting commit `A` (using the same matching rules). It is the net snapshot difference, not a replay of patches, so edits later undone by `B` do not appear.

```bash
npx difflog -o --from a1b2c3d -- d4e5f6a               # range diff to stdout
npx difflog -o combined.diff --from a1b2c3d -- d4e5f6a # range diff to a file
npx difflog -s --from a1b2c3d -- d4e5f6a               # range stat
```

`difflog` verifies `A` is an ancestor of `B` (`git merge-base --is-ancestor`): a reversed range is reported with the corrected command, and unrelated branches are rejected. A root starting commit is compared against the empty tree, and `A === B` is allowed for a non-merge commit.

## `--` is required with `-o/--output`

Because `-o/--output` takes an **optional** argument, `--` must appear **before every search term** whenever `-o/--output` is used (a late `--` is not enough). Otherwise a search term could be silently read as the output filename and create or overwrite a file, so `difflog` rejects such invocations up front without touching the filesystem.

```bash
# Valid
npx difflog -o -- JIRA-123 fix 3
npx difflog -o diff.txt -- JIRA-123 fix 3
npx difflog -s -o stat.txt -- JIRA-123 fix 3

# Invalid (rejected, nothing written)
npx difflog -o JIRA-123 fix 3               # JIRA-123 read as the output filename
npx difflog -o diff.txt JIRA-123 -- fix 3   # separator too late
```

Passing terms after `--` also keeps them from being consumed by `--exclude`.

## Matching

`difflog` matches a commit's full hash, short hash, and subject; add `-b/--body` to also search the body (matching only — the diff is unchanged). Your search is split into tokens and matched against a commit's meaningful tokens (words, hash prefixes, ticket-like forms):

- Separators split tokens, so `i18n` matches `i18n`, `i18n.ts`, and `src/i18n/messages`, but not scattered `i`/`1`/`8`/`n`.
- Typos are tolerated for 4+ character alphabetic words (`notifcation` → `notification`).
- Compact and separated ticket forms match both ways: `JIRA-177`, `jira 177`, and `jira177` all match the same ticket; the number stays exact, so `JIRA-177` never matches `JIRA-178`.

Short and numeric terms are stricter, so they don't pull in noise:

- Numeric-only terms must match a token exactly.
- 1–2 character terms must match exactly.
- 3-character terms allow an exact or prefix match only.
- 4+ character alphabetic terms allow typo tolerance.

When one match is clearly strongest it is used; commits that match in the same way are treated as ambiguous and listed for you to refine, rather than guessed.

## Metadata (`-m, --meta`)

Prepends a short, plain-text (never colorized) header before the diff or stat; for a file the reported byte count includes it.

```txt
commit d4e5f6a000000000000000000000000000000000 (d4e5f6a)
Author: Jane Doe <jane@example.com>
Date: 2026-06-04 10:15:00 -0700
Subject: JIRA-123 finalize account settings
```

For a range the header shows `From:` / `Through:` lines instead (and describes an empty-tree comparison when `A` is a root commit).

## Diff & merge behavior

- **Single commit:** equivalent to `git diff <commit>^!` — a plain diff without the `git show` header/message.
- **Root commit:** compared against the repository's empty tree (derived dynamically, so SHA-1 is not assumed).
- **Merge commit:** rejected as a single-commit diff and as a range **start** (the pre-merge state is ambiguous), but allowed as a range **end** (its tree is an unambiguous snapshot). Inspect merges directly with `git show <commit>`.

## Squash merges and `-b`

`difflog` searches commits reachable from `HEAD`. In squash-and-merge workflows the original branch commits may be gone; `-b/--body` can still find the squash commit when it records the original messages in its body. The resulting diff is the squash commit's, and unreachable branch commits cannot be recovered.

## Terminal safety

The text `difflog` formats itself (queries, subjects, body excerpts, metadata, filenames, confirmations, error details, and Git error messages) is escaped for display, so control/ANSI/bidi characters from the repository or your query cannot forge or reorder terminal output. This is display-only: filesystem paths are unchanged, and the raw `git diff` / `git diff --stat` stream is emitted byte-for-byte. Git history is parsed from NUL-delimited records, so subjects and bodies cannot forge parser boundaries.

## Requirements

- Node.js >= 22.12.0
- Git
- Run from inside a Git repository

## License

ISC
