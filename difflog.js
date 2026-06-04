#!/usr/bin/env node

import chalk from 'chalk'
import fuzzysort from 'fuzzysort'
import { Command } from 'commander'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

// Unit/record separators are extremely unlikely to appear in commit metadata,
// so we use them to split `git log` output into fields and records.
const FIELD = '\x1f'
const RECORD = '\x1e'

// How far ahead the best match must score over the runner-up before we trust it
// enough to pick it automatically instead of asking the user to refine.
const CLEAR_WINNER_GAP = 0.2
// A near-perfect score is treated as an obvious match on its own.
const NEAR_PERFECT = 0.99
// How many candidates to show when the result is ambiguous.
const LIST_LIMIT = 10

class UserError extends Error {}

function buildDiff (commit, { exclude, stat, unified }, cwd) {
  // `<hash>^!` diffs the commit against its parent, yielding a plain diff
  // without the commit header/message that `git show` would include. A root
  // commit has no parent, so diff it against this repo's empty tree instead
  // (otherwise `git diff <hash>` would compare against the working tree).
  const args = ['diff']
  if (stat) args.push('--stat')
  else if (unified !== undefined) args.push(`-U${unified}`)
  if (commit.isRoot) args.push(emptyTree(cwd), commit.hash)
  else args.push(`${commit.hash}^!`)
  if (exclude && exclude.length > 0) {
    args.push('--', '.', ...exclude.map(p => `:(exclude)${p}`))
  }
  return git(args, cwd)
}

function chooseCommit (commits, query, keys) {
  const results = fuzzysort.go(query, commits, { keys, limit: LIST_LIMIT })

  if (results.length === 0) return { kind: 'none' }

  const best = results[0]
  if (results.length === 1) return { kind: 'one', commit: best.obj }

  const second = results[1]
  const clearWinner = best.score >= NEAR_PERFECT || best.score - second.score >= CLEAR_WINNER_GAP
  if (clearWinner) return { kind: 'one', commit: best.obj }

  return { kind: 'ambiguous', results }
}

function emptyTree (cwd) {
  // Hashing empty input yields the empty tree object for this repo's object
  // format (SHA-1 or SHA-256), so root-commit diffs don't assume SHA-1.
  return git(['hash-object', '-t', 'tree', '--stdin'], cwd).trim()
}

function git (args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024 * 256
    })
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim()
    throw new UserError(chalk.red(stderr || `git ${args.join(' ')} failed`))
  }
}

function loadCommits (cwd, { body } = {}) {
  // Only request the body (%b) when body search is enabled. Parents (%P) stay
  // last so root/merge detection works regardless of whether %b is present.
  const fields = body ? ['%H', '%h', '%s', '%b', '%P'] : ['%H', '%h', '%s', '%P']
  const format = fields.join(FIELD) + RECORD
  let out
  try {
    out = git(['log', `--pretty=format:${format}`], cwd)
  } catch (err) {
    // An unborn branch (no commits yet) makes `git log` fail; treat as empty.
    if (/does not have any commits yet|bad default revision/i.test(err.message)) return []
    throw err
  }
  return out
    .split(RECORD)
    .map(record => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map(record => {
      const parts = record.split(FIELD)
      const [hash, short, subject] = parts
      const parentList = (parts[parts.length - 1] || '').trim().split(/\s+/).filter(Boolean)
      const commit = {
        hash,
        short,
        subject: subject || '',
        isMerge: parentList.length > 1,
        isRoot: parentList.length === 0
      }
      if (body) commit.body = (parts[3] || '').trim()
      return commit
    })
}

function parseUnified (value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) {
    throw new UserError(chalk.red(`Invalid value for --unified: "${value}". Expected a non-negative integer.`))
  }
  return n
}

function repoRoot () {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    throw new UserError(chalk.red('Not a git repository. Run difflog from inside a git repo.'))
  }
}

function run (query, opts) {
  if (!query || query.length === 0) {
    throw new UserError(chalk.red('Missing search terms.') + '\n' + chalk.gray('Pass them after -- so they are not consumed by --exclude.\nUsage: difflog [options] -- <search terms>\nExample: difflog -e package-lock.json -o diff.txt -- JIRA-123 mobile'))
  }

  const cwd = repoRoot()
  const commits = loadCommits(cwd, { body: opts.body })
  if (commits.length === 0) {
    throw new UserError(chalk.red('This repository has no commits yet.'))
  }

  const queryText = query.join(' ')
  const unified = opts.unified === undefined ? undefined : parseUnified(opts.unified)
  const keys = opts.body ? ['hash', 'short', 'subject', 'body'] : ['hash', 'short', 'subject']

  const outcome = chooseCommit(commits, queryText, keys)

  if (outcome.kind === 'none') {
    throw new UserError(chalk.red(`No commits matched "${queryText}".`) + ' ' + chalk.gray('Try different search terms.'))
  }

  if (outcome.kind === 'ambiguous') {
    const lines = outcome.results.map((r, i) => `  ${i + 1}. ${chalk.cyan(r.obj.short)}  ${r.obj.subject}`)
    throw new UserError(chalk.yellow(`Multiple commits matched "${queryText}". Refine your search:`) + '\n' + lines.join('\n'))
  }

  const commit = outcome.commit

  if (commit.isMerge) {
    throw new UserError(chalk.yellow(`${chalk.cyan(commit.short)} (${commit.subject}) is a merge commit.`) + '\n' + chalk.gray(`The diff for a merge is ambiguous in this tool; inspect it directly, e.g.:\n  git show ${commit.short}\n  git show --first-parent ${commit.short}`))
  }

  const diff = buildDiff(commit, { exclude: opts.exclude, stat: opts.stat, unified }, cwd)
  const kind = opts.stat ? 'stat' : 'diff'

  if (opts.output) {
    writeFileSync(opts.output, diff)
    const bytes = Buffer.byteLength(diff)
    console.log(chalk.green(`Saved ${kind} for `) + chalk.cyan(commit.short) + chalk.green(` -> ${commit.subject} to ${opts.output} `) + chalk.gray(`(${bytes} bytes)`))
  } else {
    // Stdout stays raw git output: no size message, nothing extra.
    process.stdout.write(diff)
  }
}

const program = new Command()

program
  .name('difflog')
  .description('Fuzzy-search git history by commit message and print or save the commit diff.')
  .argument('[query...]', 'search terms (pass after --)')
  .option('-b, --body', 'include commit body in fuzzy search')
  .option('-e, --exclude <path...>', 'exclude one or more paths from the diff (repeatable)', (value, previous = []) => previous.concat(value))
  .option('-o, --output <file>', 'write diff output to a file')
  .option('-s, --stat', 'output diff stat instead of the full patch')
  .option('-u, --unified <lines>', 'number of unified diff context lines')
  .action((query, opts) => {
    try {
      run(query, opts)
    } catch (err) {
      if (err instanceof UserError) {
        console.error(err.message)
        process.exitCode = 1
        return
      }
      throw err
    }
  })

program.parse()
