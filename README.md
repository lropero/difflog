# difflog

Find a commit by typo-tolerant search over `git` history and print its diff.

`difflog` is a small CLI helper for quickly finding a commit by message or hash and outputting the diff for that commit. It uses token-aware, typo-tolerant matching: it tolerates small typos in words but does not match arbitrary scattered characters.

## Usage

```bash
npx difflog [options] -- <search terms>
```

Example:

```bash
npx difflog -e package-lock.json -o diff.txt -u 999999 -- JIRA-123 mobile
```

This searches the Git history for a commit similar to:

```txt
JIRA-123 mobile
```

Then outputs the diff for the matched commit, excluding `package-lock.json`, using `999999` unified context lines, and saving the result to `diff.txt`.

## Options

```txt
-b, --body                Include commit body in the search
-e, --exclude <path...>   Exclude one or more paths from the diff
-m, --meta                Prepend a commit metadata header to the output
-o, --output <file>       Write diff output to a file
-s, --stat                Output diff stat instead of the full patch
-u, --unified <lines>     Number of unified diff context lines
```

CLI messages (errors, the saved confirmation, ambiguous lists, and hints) are lightly colored for readability. The actual diff or stat is always raw Git output with no coloring, so it stays safe to pipe or redirect.

By default, stdout is raw Git diff/stat output with nothing printed before or after it. The only exception is `-m, --meta`, which prepends a plain (uncolored) metadata header to the output.

Output size in bytes is reported only when writing to a file with `-o`, and that byte count covers everything written to the file, including the `--meta` header when used.

When writing with `-o`, output goes to a temporary file that is moved into place only after Git succeeds, so a failed run never leaves a partial or misleading file at the requested path. Streamed stdout has no such guarantee: if Git fails after output has started, stdout may already contain partial output.

## Examples

Print a commit diff to stdout:

```bash
npx difflog -- JIRA-123 mobile
```

Save a commit diff to a file:

```bash
npx difflog -o diff.txt -- JIRA-123 mobile
# Saved diff for abc1234 -> JIRA-123 Fix mobile view to diff.txt (123456 bytes)
```

Show a diff stat instead of the full patch:

```bash
npx difflog -s -- JIRA-123 mobile
```

Save a diff stat to a file:

```bash
npx difflog -s -o stat.txt -- JIRA-123 mobile
# Saved stat for abc1234 -> JIRA-123 Fix mobile view to stat.txt (1234 bytes)
```

Combine excludes with a stat:

```bash
npx difflog -s -e package-lock.json -- JIRA-123 mobile
```

Include the commit body in the search (matching beyond the subject):

```bash
npx difflog -b -- "rollback plan"
```

Prepend a commit metadata header (handy for code review or AI review):

```bash
npx difflog -m -- JIRA-123 mobile
```

Save a diff with its metadata header to a file (byte count includes the header):

```bash
npx difflog --meta -o diff.txt -- JIRA-123 mobile
```

Prepend metadata to a stat:

```bash
npx difflog -m -s -- JIRA-123 mobile
```

Exclude one file:

```bash
npx difflog -e package-lock.json -- JIRA-123 mobile
```

Exclude multiple files:

```bash
npx difflog -e package-lock.json yarn.lock pnpm-lock.yaml -- JIRA-123 mobile
```

Repeat `-e`:

```bash
npx difflog -e package-lock.json -e yarn.lock -- JIRA-123 mobile
```

Use a large unified context:

```bash
npx difflog -u 999999 -- JIRA-123 mobile
```

Search by short hash:

```bash
npx difflog -- abc1234
```

Search by full hash:

```bash
npx difflog -- abc1234567890abcdef1234567890abcdef12345678
```

## Important: use `--` before search terms

When using options, especially `--exclude`, pass search terms after `--`:

```bash
npx difflog -e package-lock.json -- JIRA-123 mobile
```

This prevents search terms from being interpreted as option values.

## Matching behavior

`difflog` searches commit history using:

- full commit hash
- short commit hash
- commit subject

With `-b, --body`, the commit body is also included in the search. `-b` only affects matching; it does not change the diff or stat output.

`difflog` uses **token-aware, typo-tolerant matching**. Your search is split on whitespace, and each term is matched against the meaningful tokens of a commit (words, hash prefixes, and ticket-like forms). It is fuzzy in a useful sense — it tolerates small typos and close word matches — but it does **not** match arbitrary characters scattered across unrelated text.

What this means in practice:

- Tokens are split on separators too, so a search for `i18n` matches `i18n`, `i18n.ts`, `fix-i18n-routing`, and `src/i18n/messages`, but not unrelated text where only the characters `i`, `1`, `8`, `n` happen to appear.
- Typos are tolerated for longer alphabetic words: `notifcation` matches `notification`, and `interantionalization` matches `internationalization`.
- A multi-term search like `mobile spacing` matches commits where both meaningful terms are present (or typo-close), preferably in the subject.
- Compact and separated ticket-like forms match each other both ways: `JIRA-177`, `jira 177`, and `jira177` all match the same ticket (likewise `SMTY-318` / `smty318`). The number stays exact, so `JIRA-177` never matches `JIRA-178`.

**Very short and numeric terms are matched more strictly**, so they don't pull in noise:

- Numeric-only terms (such as ticket, PR, or issue numbers) must match a token exactly, so `JIRA-177` never drifts to `JIRA-178`.
- 1–2 character terms must match a token exactly.
- 3-character terms allow an exact or prefix match only.
- 4+ character alphabetic terms allow typo tolerance.

`i18n` is short and contains digits, but it is a meaningful developer token, so it is matched like a literal token rather than a loose fuzzy pattern.

### Ranking and ambiguity

Matches are ranked predictably, roughly preferring (strongest first): an exact full/short hash or hash prefix; a full phrase in the subject; all terms in the subject; typo-tolerant subject matches; and then, only with `-b`, the equivalent body matches and mixed subject/body matches.

If there is one clear best match, it prints or saves that commit’s diff.

If multiple commits match equally well, `difflog` does not guess. It prints a ranked list and asks you to refine the search. Ambiguity comes from multiple genuinely meaningful matches, not from scattered-character noise.

When `-b` is used and a result matched through its body rather than the visible subject or hash, the ranked list adds a short, single-line `body:` excerpt with the matched token highlighted, so you can see why it matched. These excerpts appear only in the terminal refine-your-search message, never in saved diff/stat output, and full commit bodies are never printed.

Example:

```txt
Multiple commits matched "mobile". Refine your search:
  1. abc1234  JIRA-123 Fix mobile view for tenant clients page
  2. def5678  JIRA-124 Improve mobile spacing in assessment form
```

Example with a body excerpt (only with `-b`, when the body is what matched):

```txt
Multiple commits matched "i18n". Refine your search:
  1. abc1234  SMTY-123 Update i18n message loading
  2. def5678  SMTY-124 Refactor locale files
     body: ...moved i18n resources into src/i18n/messages...
```

## Commit metadata (`-m, --meta`)

With `-m, --meta`, `difflog` prepends a short, plain-text header before the diff or stat:

```txt
commit abc1234567890abcdef1234567890abcdef123456 (abc1234)
Author: Jane Doe <jane@example.com>
Date: 2026-06-04 10:15:00 -0700
Subject: JIRA-123 Fix mobile view

diff --git a/...
```

The header includes the full hash, short hash, author (when available), commit date (when available), and subject. It is never colorized, so the saved file (or piped output) stays plain text. When writing with `-o`, the reported byte count includes the header.

## Squash merges and commit body search

By default, `difflog` searches commits reachable from the current `HEAD`.

In squash-and-merge workflows, the individual commits from a feature branch are collapsed into a single commit on the target branch, so the original branch commits may not appear in the target branch history at all.

`-b, --body` can help here: squash commits may record the original commit messages in their body (depending on the merge platform, its settings, and whether the squash message was edited), so searching bodies can surface the squash commit that absorbed the change you remember.

A few limitations to keep in mind:

- If `-b` finds a squash commit by its body, the resulting diff is the diff of the **squash commit**, not the original branch commit.
- `difflog` cannot recover original branch commits that are no longer reachable in your local repository.
- Searching across all refs or deep branch history is intentionally not part of this release.

## Diff behavior

For normal commits, `difflog` outputs the equivalent of:

```bash
git diff <commit>^!
```

That means the output is a plain diff for the selected commit, without the commit header or commit message metadata included by `git show`.

For root commits, `difflog` compares the root commit against the repository’s empty tree, so the output shows what the first commit introduced.

## Merge commits

Merge commits are not diffed automatically.

A merge commit can be interpreted in multiple ways, so `difflog` stops with a clear message instead of producing misleading output.

For merge commits, inspect the commit manually with Git:

```bash
git show <commit>
git show --first-parent <commit>
```

## Requirements

- Node.js >= 22.12.0
- Git
- Run from inside a Git repository

## License

ISC
