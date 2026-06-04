# difflog

Find a commit by fuzzy-searching `git log` and print its diff.

`difflog` is a small CLI helper for quickly finding a commit by message or hash and outputting the diff for that commit.

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
-e, --exclude <path...>   Exclude one or more paths from the diff
-o, --output <file>       Write diff output to a file
-u, --unified <lines>     Number of unified diff context lines
```

## Examples

Print a commit diff to stdout:

```bash
npx difflog -- JIRA-123 mobile
```

Save a commit diff to a file:

```bash
npx difflog -o diff.txt -- JIRA-123 mobile
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

If there is one clear best match, it prints or saves that commit’s diff.

If multiple commits match similarly, `difflog` does not guess. It prints a ranked list and asks you to refine the search.

Example:

```txt
Multiple commits matched "mobile". Refine your search:
  1. abc1234  JIRA-123 Fix mobile view for tenant clients page
  2. def5678  JIRA-124 Improve mobile spacing in assessment form
```

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

- Node.js >= 20
- Git
- Run from inside a Git repository

## License

ISC
