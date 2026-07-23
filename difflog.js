#!/usr/bin/env node

import chalk from 'chalk'
import { Command } from 'commander'
import { createWriteStream, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync, spawn, spawnSync } from 'node:child_process'

// Relative strength of a single term-vs-token match, used for tie-breaking.
const KIND_RANK = { exact: 3, prefix: 2, typo: 1 }
// How many candidates to show when a result is truncated (lookup or ambiguity).
const LIST_LIMIT = 10
// Shortest query length we are willing to treat as a (possibly partial) hash.
const MIN_HASH_LEN = 4
// Match tiers, from strongest to weakest. The choice between "one clear match"
// and an ambiguous list is made on tier alone: a commit only wins outright when
// it matches in a strictly stronger way than the runner-up (e.g. subject over
// body, exact over typo). Commits that match in the same way are treated as
// genuinely ambiguous and listed so the user can refine.
const TIER = {
  HASH_FULL: 100, // query equals the full commit hash
  HASH_SHORT: 99, // query equals the short commit hash
  HASH_PREFIX: 98, // query is a hash/short-hash prefix
  SUBJECT_PHRASE: 90, // query terms appear contiguously in the subject
  SUBJECT_ALL: 80, // every query term matches a subject token (exact/prefix)
  SUBJECT_TYPO: 70, // every query term matches a subject token, some via a typo
  BODY_PHRASE: 60, // contiguous phrase in the body (-b only)
  BODY_ALL: 50, // every query term matches a body token (-b only)
  BODY_TYPO: 40, // every query term matches a body token, some via a typo (-b only)
  MIXED: 30 // terms split across subject and body (-b only)
}

class UserError extends Error {}

function addExcludes (args, exclude) {
  if (exclude && exclude.length > 0) {
    args.push('--', '.', ...exclude.map(path => `:(exclude)${path}`))
  }
  return args
}

function allowedDistance (len) {
  // Typo tolerance by term length, kept strict so short tokens never pull in
  // noise (a typo on "api" should not reach "app"):
  //   1-3 chars: no typos (exact, or prefix when 3+ chars).
  //   4-6 chars: at most one typo.
  //   7+  chars: at most two typos.
  if (len <= 3) return 0
  if (len <= 6) return 1
  return 2
}

function ambiguityError (role, q, results) {
  let firstLine
  let refine
  if (role === 'from') {
    firstLine = `Multiple commits matched the starting query "${displayText(q.text)}".`
    refine = 'Refine --from:'
  } else if (role === 'ending') {
    firstLine = `Multiple commits matched the ending query "${displayText(q.text)}".`
    refine = 'Refine the search:'
  } else {
    firstLine = `Multiple commits matched "${displayText(q.text)}".`
    refine = 'Refine the search:'
  }
  const rows = results.map((r, i) => formatMatchRow(r, i))
  return new UserError(chalk.yellow(`${firstLine}\n${refine}`) + '\n\n' + rows.join('\n'))
}

function baseDiffArgs ({ stat, unified }) {
  const args = ['diff']
  if (stat) args.push('--stat')
  else if (unified !== undefined) args.push(`-U${unified}`)
  return args
}

function bodyExcerpt (body, hits) {
  // Build a concise, single-line excerpt of a commit body around the first
  // matched token, with matched tokens in cyan and context in gray. Terminal
  // only; never used in saved output. Returns '' when there is nothing to show.
  if (!body || !hits || hits.length === 0) return ''
  const lower = body.toLowerCase()
  let pos = -1
  let hitLen = 0
  for (const h of hits) {
    const i = lower.indexOf(h)
    if (i !== -1 && (pos === -1 || i < pos)) {
      pos = i
      hitLen = h.length
    }
  }
  if (pos === -1) return ''
  const WINDOW = 72
  const start = Math.max(0, pos - Math.floor((WINDOW - hitLen) / 2))
  const end = Math.min(body.length, start + WINDOW)
  const text = body.slice(start, end).replace(/\s+/g, ' ').trim()
  const matched = new Set(hits)
  let out = ''
  for (const part of text.match(/[a-z0-9]+|[^a-z0-9]+/gi) || []) {
    // Match against the original token, but only ever render the escaped fragment
    // so body text cannot emit raw terminal controls.
    const safePart = displayText(part)
    if (/^[a-z0-9]+$/i.test(part) && matched.has(part.toLowerCase())) out += chalk.cyan(safePart)
    else out += chalk.gray(safePart)
  }
  const prefix = start > 0 ? chalk.gray('...') : ''
  const suffix = end < body.length ? chalk.gray('...') : ''
  return prefix + out + suffix
}

function byScore (matches) {
  return [...matches].sort((a, b) => b.tier - a.tier || b.quality - a.quality)
}

function commitMeta (commit, cwd) {
  // A small, plain (uncolored) header useful when saving a single-commit diff.
  // NUL-delimited fields (via `-z` and %x00) keep author/date text with embedded
  // control characters from shifting field boundaries.
  const out = git(['show', '-s', '-z', '--date=iso', '--format=%an%x00%ae%x00%ad', commit.hash], cwd)
  const values = out.split('\0')
  if (values.at(-1) === '') values.pop()
  if (values.length !== 3) {
    throw new UserError(chalk.red('Could not parse commit metadata.'))
  }
  const [name, email, date] = values
  const lines = [`commit ${commit.hash} (${commit.short})`]
  if (name) lines.push(`Author: ${displayText(name)}${email ? ` <${displayText(email)}>` : ''}`)
  if (date) lines.push(`Date: ${displayText(date)}`)
  lines.push(`Subject: ${displayText(commit.subject)}`)
  return lines.join('\n') + '\n\n'
}

function displayError (err) {
  // Serialize an OS/Node error detail for display only. Filesystem error messages
  // frequently repeat the affected path, so escaping the message (not just the
  // filename we print separately) keeps embedded control characters or ANSI
  // sequences from altering terminal output.
  const message = err && typeof err.message === 'string' ? err.message : String(err)
  return displayValue(message)
}

function displayMatches (matches, q) {
  // Lookup output: choose which matches survive truncation purely by Git history
  // order (oldest first), never by fuzzy score, then display them oldest to
  // newest. This guarantees the visible rows are the oldest matching commits, so
  // a newer high-scoring commit can never push an older match out of view.
  const total = matches.length
  const shown = oldestFirst(matches).slice(0, LIST_LIMIT)
  const truncated = total > LIST_LIMIT
  const noun = total === 1 ? 'commit' : 'commits'
  let header
  if (total === 1) {
    header = `${total} ${noun} matched "${displayText(q.text)}":`
  } else if (truncated) {
    header = `${total} ${noun} matched "${displayText(q.text)}". Showing the oldest ${LIST_LIMIT}:`
  } else {
    header = `${total} ${noun} matched "${displayText(q.text)}" (oldest to newest):`
  }
  const rows = shown.map((r, i) => formatMatchRow(r, i))
  return header + '\n\n' + rows.join('\n')
}

function displayText (value) {
  // Like displayValue(), but for text shown inside an already human-readable
  // sentence (e.g. a commit subject or query) rather than as a standalone quoted
  // value. displayValue() always returns a JSON-quoted string, so stripping the
  // leading and trailing quote yields the same control-character escaping without
  // adding a second pair of quotes.
  const serialized = displayValue(value)
  return serialized.slice(1, -1)
}

function displayValue (value) {
  // Serialize an untrusted value (e.g. a user-supplied output filename) for
  // display only, using JSON string escaping so embedded quotes, newlines, ANSI
  // sequences, or other control characters cannot forge extra terminal lines or
  // alter layout. Used anywhere such a value is shown (missing-query diagnostics,
  // saved confirmations, write errors); the real filesystem path is never changed
  // and it is never placed inside a copyable shell command.
  //
  // JSON.stringify already escapes C0 controls (newline, ESC, ...); we also escape
  // DEL, the C1 control range, the Unicode line/paragraph separators, and Unicode
  // bidirectional-formatting controls, which it leaves literal but which can still
  // affect (or visually reorder) terminal rendering.
  return JSON.stringify(String(value)).replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

function editDistance (a, b, max) {
  // Bounded Levenshtein distance. Returns max + 1 as soon as it is clear the
  // distance exceeds `max`, so comparisons against long tokens stay cheap.
  const m = a.length
  const n = b.length
  if (Math.abs(m - n) > max) return max + 1
  let prev = new Array(n + 1)
  let curr = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    let rowMin = curr[0]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      if (curr[j] < rowMin) rowMin = curr[j]
    }
    if (rowMin > max) return max + 1
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[n]
}

function emptyTree (cwd) {
  // Hashing empty input yields the empty tree object for this repo's object
  // format (SHA-1 or SHA-256), so root-commit diffs don't assume SHA-1.
  return git(['hash-object', '-t', 'tree', '--stdin'], cwd).trim()
}

function evalField (q, fieldTokens) {
  // Evaluate the query against one field's tokens. A field counts as a match when
  // either every query term matches a token individually, or the whole query
  // matches a contiguous run as a compact phrase (so "jira177" matches a
  // "JIRA-177" field even though "177" has no standalone token). Partial matches
  // are left for the mixed subject+body case to consider.
  const matches = q.tokens.map(t => matchTermInField(t, fieldTokens))
  const run = phraseRun(q.compact, fieldTokens)
  const phrase = run !== null
  const allMatched = q.tokens.length > 0 && (phrase || matches.every(Boolean))

  let hasTypo = false
  let strength = 0
  let first = Infinity
  // Tokens that explain the match, used for body excerpts. A compact phrase may
  // match without per-term token matches, so include the run's tokens too.
  const hits = []
  const seen = new Set()
  const addHit = token => {
    if (!seen.has(token)) {
      seen.add(token)
      hits.push(token)
    }
  }
  for (const m of matches) {
    if (!m) continue
    if (m.kind === 'typo') hasTypo = true
    strength += KIND_RANK[m.kind]
    if (m.index < first) first = m.index
    addHit(m.token)
  }
  if (run) {
    if (run.start < first) first = run.start
    for (const token of run.tokens) addHit(token)
  }
  // Tie-breaker within a tier: stronger matches, earlier in the text, and a
  // tighter field (fewer unrelated tokens) score higher.
  const position = first === Infinity ? 0 : 1 / (1 + first)
  const tightness = fieldTokens.length > 0 ? q.tokens.length / fieldTokens.length : 0
  const quality = strength + position + tightness
  return { matches, allMatched, phrase, hasTypo, hits, quality }
}

function findMatches (commits, q, useBody) {
  // Score every commit and return the meaningful matches (unordered). Lookup and
  // endpoint selection share this; they differ only in how they present it.
  const scored = []
  for (const commit of commits) {
    const match = scoreCommit(commit, q, useBody)
    if (match) scored.push({ commit, ...match })
  }
  return scored
}

function formatMatchRow (r, i) {
  // A single numbered row for lookup lists and ambiguity lists. The short hash
  // and subject are already visible, so only add an explanation line when the
  // body (not the subject/hash) is what matched.
  let row = `  ${i + 1}. ${chalk.cyan(r.commit.short)}  ${displayText(r.commit.subject)}`
  if ((r.source === 'body' || r.source === 'mixed') && r.bodyHits && r.bodyHits.length > 0) {
    const excerpt = bodyExcerpt(r.commit.body, r.bodyHits)
    if (excerpt) row += '\n     ' + chalk.gray('body: ') + excerpt
  }
  return row
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
    // Escape git's stderr for display so ANSI/OSC/control characters in it cannot
    // forge terminal output; the raw diff/stat stream is never routed through here.
    throw new UserError(chalk.red(displayText(stderr) || `git ${displayText(args.join(' '))} failed`))
  }
}

function hashMatch (commit, q) {
  // Treat a lone hex-looking query as a hash search and rank exact/prefix hits
  // above any text match.
  const t = q.hashToken
  if (!t) return null
  if (commit.hash === t) return { tier: TIER.HASH_FULL, quality: t.length }
  if (commit.short === t) return { tier: TIER.HASH_SHORT, quality: t.length }
  if (commit.hash.startsWith(t) || commit.short.startsWith(t)) return { tier: TIER.HASH_PREFIX, quality: t.length }
  return null
}

function isAncestor (ancestor, descendant, cwd) {
  // `git merge-base --is-ancestor` exits 0 when true and 1 when false; only other
  // exit codes are real git failures. spawnSync lets us read that status directly
  // instead of treating exit 1 as an execution error.
  const res = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (res.error) throw new UserError(chalk.red(displayText(res.error.message)))
  if (res.status === 0) return true
  if (res.status === 1) return false
  // Escape git's stderr for display (consistent with git()); it is CLI-generated
  // error text, not raw diff/stat output.
  throw new UserError(chalk.red(displayText((res.stderr || '').toString().trim()) || 'git merge-base --is-ancestor failed'))
}

function loadCommits (cwd, { body } = {}) {
  // Only request the body (%b) when body search is enabled. Parents (%P) stay
  // last so root/merge detection works regardless of whether %b is present.
  // Fields are NUL-delimited (%x00) and records are NUL-delimited via `-z`. Git
  // rejects NUL bytes inside commit objects, so a crafted subject or body cannot
  // forge a field or record boundary (unlike arbitrary control-character
  // sentinels, which can legitimately occur in commit messages).
  const fields = body ? ['%H', '%h', '%s', '%b', '%P'] : ['%H', '%h', '%s', '%P']
  const width = fields.length
  const format = fields.join('%x00')
  let out
  try {
    // `--topo-order` guarantees a topology-respecting traversal: every commit is
    // listed before any of its ancestors (newest to oldest), regardless of author
    // or committer dates. Reversing this (see oldestFirst) therefore always shows
    // parents before descendants, even with merges or non-monotonic timestamps.
    out = git(['log', '--topo-order', '-z', `--pretty=format:${format}`], cwd)
  } catch (err) {
    // An unborn branch (no commits yet) makes `git log` fail; treat as empty.
    if (/does not have any commits yet|bad default revision/i.test(err.message)) return []
    throw err
  }
  if (!out) return []
  const values = out.split('\0')
  // `%x00` separates fields and `-z` separates records. Because the final field
  // is `%P`, a root commit legitimately contributes an empty final value; keep it
  // (it is the root commit's empty parent field, not a trailing terminator).
  if (values.length % width !== 0) {
    throw new UserError(chalk.red('Could not parse Git history output.'))
  }
  const commits = []
  for (let offset = 0, logIndex = 0; offset < values.length; offset += width, logIndex++) {
    const record = values.slice(offset, offset + width)
    const [hash, short, subject] = record
    const parentList = record[width - 1].trim().split(/\s+/).filter(Boolean)
    const commit = {
      hash,
      short,
      subject: subject || '',
      isMerge: parentList.length > 1,
      isRoot: parentList.length === 0,
      // `--topo-order` lists newest first in a topology-respecting traversal, so
      // this preserves each commit's original history position (0 = newest) for
      // oldest-to-newest display ordering.
      logIndex
    }
    if (body) commit.body = (record[3] || '').trim()
    commits.push(commit)
  }
  return commits
}

function matchTermInField (term, fieldTokens) {
  // Best match for one term anywhere in a field's tokens, preferring exact over
  // prefix over typo. Returns null when the term matches no token.
  let best = null
  for (let i = 0; i < fieldTokens.length; i++) {
    const kind = matchToken(term, fieldTokens[i])
    if (!kind) continue
    if (!best || KIND_RANK[kind] > KIND_RANK[best.kind]) {
      best = { kind, index: i, token: fieldTokens[i] }
      if (kind === 'exact') break
    }
  }
  return best
}

function matchToken (term, token) {
  // How a single query term relates to a single commit token: an exact match, a
  // prefix (e.g. "config" -> "configuration"), a typo-close match, or nothing.
  if (term === token) return 'exact'
  // Numeric-only terms (ticket IDs, PR/issue numbers) must match exactly, so a
  // search never drifts to a neighbor like 177 -> 178.
  if (/^\d+$/.test(term)) return null
  if (term.length >= 3 && token.startsWith(term)) {
    // Allow prefix matches, but never let a trailing number grow into a
    // different one ("smty319" must not match "smty3190").
    if (!(/\d$/.test(term) && /\d/.test(token[term.length]))) return 'prefix'
  }
  // Typo tolerance is for alphabetic words only. Any term containing a digit
  // (compact ticket forms like "smty319", developer tokens like "i18n") is
  // matched only at the token level, so a digit never drifts to a neighboring
  // value (e.g. "smty319" must not typo-match "smty318").
  if (/\d/.test(term)) return null
  const allowed = allowedDistance(term.length)
  if (allowed > 0 && editDistance(term, token, allowed) <= allowed) return 'typo'
  return null
}

function missingQuery (mode, opts) {
  // Because `-o/--output` takes an optional argument, `difflog -o report.diff`
  // makes commander parse "report.diff" as the output filename, leaving no query.
  // We cannot know whether the user forgot the search terms or meant that word as
  // the query, so we state only how commander parsed it (safely serialized) and
  // show both corrections with placeholders (kept mode-specific, so stat examples
  // keep -s). The untrusted filename is never placed inside a copyable command.
  // Otherwise we show the general reminder to pass search terms after `--`.
  if (typeof opts.output === 'string') {
    const kind = mode === 'stat' ? 'stat' : 'diff'
    const prefix = mode === 'stat' ? 'difflog -s -o' : 'difflog -o'
    return new UserError(chalk.red('Missing search terms.') + '\n\n' + chalk.gray(`${displayValue(opts.output)} was parsed as the output filename.\n\nTo save the ${kind} there:\n  ${prefix} <output-file> -- <search terms>\n\nIf that value was intended as the search term:\n  ${prefix} -- <search terms>`))
  }
  return new UserError(chalk.red('Missing search terms.') + '\n' + chalk.gray('Pass them after -- so they are not consumed by options.\nUsage: difflog [options] -- <search terms>\nExample: difflog -- JIRA-123 mobile'))
}

function noMatchError (role, q, useBody) {
  const hint = useBody ? 'Try different search terms.' : 'Try different search terms, or -b/--body to also search commit message bodies.'
  let subject
  if (role === 'from') subject = `No commits matched the starting query "${displayText(q.text)}".`
  else if (role === 'ending') subject = `No commits matched the ending query "${displayText(q.text)}".`
  else subject = `No commits matched "${displayText(q.text)}".`
  return new UserError(chalk.red(subject) + ' ' + chalk.gray(hint))
}

function oldestFirst (matches) {
  // Topological history order: the git log (`--topo-order`) is newest first, so a
  // larger logIndex is older. Sorting by logIndex descending yields oldest to
  // newest with every parent before its descendants, and never depends on fuzzy
  // quality or (rewritable) author/committer dates.
  return [...matches].sort((a, b) => b.commit.logIndex - a.commit.logIndex)
}

function outputMode (opts) {
  // `--stat` is its own output mode (with or without a file). `-o/--output` in
  // any form (with or without a file) requests a full diff. Otherwise the default
  // is a lookup listing.
  if (opts.stat) return 'stat'
  if (opts.output !== undefined) return 'diff'
  return 'list'
}

function parseUnified (value) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) {
    throw new UserError(chalk.red(`Invalid value for --unified: ${displayValue(value)}. Expected a non-negative integer.`))
  }
  return n
}

function phraseRun (compact, fieldTokens) {
  // Find the contiguous run of field tokens whose concatenation (separators
  // removed) exactly equals the whole query. This matches compact and separated
  // forms of the same thing both ways: query "jira177" and query "JIRA-177"
  // (both compact "jira177") match text "JIRA-177", "jira 177", or "jira177".
  // Because the concatenation must match exactly, ticket numbers never drift
  // ("jira177" will not match "jira178") and characters are never scattered.
  // Returns the matched tokens plus their start index, or null when there is no
  // such run.
  if (!compact) return null
  for (let i = 0; i < fieldTokens.length; i++) {
    let acc = ''
    for (let j = i; j < fieldTokens.length; j++) {
      acc += fieldTokens[j]
      if (acc === compact) return { tokens: fieldTokens.slice(i, j + 1), start: i }
      if (acc.length >= compact.length) break
    }
  }
  return null
}

function prepareQuery (query) {
  // Split the search on whitespace and separators into meaningful tokens, and
  // remember whether the whole query is a single hash-looking token.
  const text = query.join(' ')
  const tokens = tokenize(text)
  const compact = tokens.join('')
  const lone = query.length === 1 ? query[0].toLowerCase() : ''
  const hashToken = new RegExp(`^[0-9a-f]{${MIN_HASH_LEN},64}$`).test(lone) ? lone : null
  return { text, tokens, compact, hashToken }
}

function rangeCommandPrefix (opts) {
  // Build the corrective command prefix for a reversed range so the suggestion
  // keeps the user's chosen output mode (stat vs full diff, stdout vs file)
  // instead of always suggesting `-o`. A requested output file becomes a
  // `<output-file>` placeholder so an untrusted filename never lands in a
  // copyable command; only short commit hashes (safe hex) are substituted in.
  const toFile = typeof opts.output === 'string'
  if (opts.stat) return toFile ? 'difflog -s -o <output-file>' : 'difflog -s'
  return toFile ? 'difflog -o <output-file>' : 'difflog -o'
}

function rangeDiffArgs (start, end, options, cwd) {
  // Inclusive range: compare the snapshot immediately before the starting commit
  // (its first parent, or the empty tree for a root) against the ending commit's
  // snapshot. This is the net difference `git diff A^1 B`, not a replay of
  // individual patches, so undone edits never appear in the output.
  const args = baseDiffArgs(options)
  const base = start.isRoot ? emptyTree(cwd) : `${start.hash}^1`
  args.push(base, end.hash)
  return addExcludes(args, options.exclude)
}

function rangeMeta (start, end, cwd) {
  // A plain (uncolored) header describing an inclusive range. A root starting
  // commit has no `^1`, so it is described as an empty-tree comparison instead.
  const base = start.isRoot ? emptyTree(cwd) : `${start.hash}^1`
  const lines = [`range ${base}..${end.hash}`]
  lines.push(`From: ${start.short}  ${displayText(start.subject)}${start.isRoot ? ' (root commit)' : ''}`)
  lines.push(`Through: ${end.short}  ${displayText(end.subject)}`)
  return lines.join('\n') + '\n\n'
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

function requiresOutput (flag) {
  let msg = chalk.red(`${flag} requires -o/--output or -s/--stat.`)
  if (flag === '--from') {
    msg += '\n\n' + chalk.gray('To output an inclusive range diff:\n  difflog -o --from <start-query> -- <end-query>')
  }
  return new UserError(msg)
}

function resolveEndpoint (commits, q, useBody, role) {
  // Resolve a query to a single commit for diff/stat output, throwing a
  // role-specific UserError when nothing matches or the result is ambiguous.
  const selection = selectCommit(findMatches(commits, q, useBody))
  if (selection.kind === 'none') throw noMatchError(role, q, useBody)
  if (selection.kind === 'ambiguous') throw ambiguityError(role, q, selection.results)
  return selection.commit
}

async function run (query, opts, argv) {
  const mode = outputMode(opts)
  const outputFile = typeof opts.output === 'string' ? opts.output : undefined

  validateOptions(mode, opts)

  // An empty output filename (`--output=` or `-o ""`) must never be treated as
  // stdout output or produce a false saved confirmation.
  if (opts.output === '') {
    throw new UserError(chalk.red('The output filename must not be empty.'))
  }

  // `-o/--output` has an optional argument, so a search term can be silently
  // swallowed as the output filename (and a file created or overwritten) unless
  // every positional term comes from the raw arguments after `--`. A late `--`
  // (placed after terms commander already consumed) is rejected too: merely
  // containing `--` somewhere is not enough. The case where no positional query
  // survives is handled by the missing-query diagnostic below.
  const separatorIndex = argv.indexOf('--')
  const rawQuery = separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1)
  const queryIsEntirelyAfterSeparator = query.length === rawQuery.length && query.every((term, index) => term === rawQuery[index])
  if (opts.output !== undefined && query.length > 0 && !queryIsEntirelyAfterSeparator) {
    throw new UserError(chalk.red('-o/--output requires -- before all search terms.') + '\n\n' + chalk.gray('Examples:\n  difflog -o -- JIRA-123 fix 3\n  difflog -o diff.txt -- JIRA-123 fix 3'))
  }

  if (!query || query.length === 0) {
    throw missingQuery(mode, opts)
  }

  const cwd = repoRoot()
  const commits = loadCommits(cwd, { body: opts.body })
  if (commits.length === 0) {
    throw new UserError(chalk.red('This repository has no commits yet.'))
  }

  const q = prepareQuery(query)

  if (mode === 'list') {
    const matches = findMatches(commits, q, opts.body)
    if (matches.length === 0) throw noMatchError('lookup', q, opts.body)
    console.log(displayMatches(matches, q))
    return
  }

  const unified = opts.unified === undefined ? undefined : parseUnified(opts.unified)
  const options = { exclude: opts.exclude, stat: opts.stat, unified }
  const kind = opts.stat ? 'stat' : 'diff'

  if (opts.from !== undefined) {
    const start = resolveEndpoint(commits, prepareQuery([opts.from]), opts.body, 'from')
    const end = resolveEndpoint(commits, q, opts.body, 'ending')
    if (start.isMerge) {
      throw new UserError(chalk.yellow(`${start.short} is a merge commit and cannot be used as --from.`) + '\n\n' + chalk.gray('The state before a merge depends on which parent is selected.'))
    }
    validateRange(start, end, cwd, opts)
    const args = rangeDiffArgs(start, end, options, cwd)
    const meta = opts.meta ? rangeMeta(start, end, cwd) : ''
    const bytes = await streamDiff(args, cwd, { meta, output: outputFile })
    if (outputFile !== undefined) {
      console.log(chalk.green(`Saved ${kind} from `) + chalk.cyan(start.short) + chalk.green(' through ') + chalk.cyan(end.short) + chalk.green(` to ${displayValue(outputFile)} `) + chalk.gray(`(${bytes} bytes)`))
    }
    return
  }

  const commit = resolveEndpoint(commits, q, opts.body, 'single')
  if (commit.isMerge) {
    throw new UserError(chalk.yellow(`${chalk.cyan(commit.short)} (${displayText(commit.subject)}) is a merge commit.`) + '\n' + chalk.gray(`The diff for a merge is ambiguous in this tool; inspect it directly, e.g.:\n  git show ${commit.short}\n  git show --first-parent ${commit.short}`))
  }
  const args = singleDiffArgs(commit, options, cwd)
  const meta = opts.meta ? commitMeta(commit, cwd) : ''
  const bytes = await streamDiff(args, cwd, { meta, output: outputFile })
  if (outputFile !== undefined) {
    console.log(chalk.green(`Saved ${kind} for `) + chalk.cyan(commit.short) + chalk.green(` -> ${displayText(commit.subject)} to ${displayValue(outputFile)} `) + chalk.gray(`(${bytes} bytes)`))
  }
}

function scoreCommit (commit, q, useBody) {
  // Score one commit against the query and return its single strongest match
  // (or null when nothing meaningful matched).
  const candidates = []

  const hash = hashMatch(commit, q)
  if (hash) candidates.push({ tier: hash.tier, quality: hash.quality, source: 'hash' })

  const subject = evalField(q, tokenize(commit.subject))
  if (subject.allMatched) {
    const tier = subject.phrase ? TIER.SUBJECT_PHRASE : subject.hasTypo ? TIER.SUBJECT_TYPO : TIER.SUBJECT_ALL
    candidates.push({ tier, quality: subject.quality, source: 'subject' })
  }

  if (useBody) {
    const body = evalField(q, tokenize(commit.body))
    if (body.allMatched) {
      const tier = body.phrase ? TIER.BODY_PHRASE : body.hasTypo ? TIER.BODY_TYPO : TIER.BODY_ALL
      candidates.push({ tier, quality: body.quality, source: 'body', bodyHits: body.hits })
    } else if (!subject.allMatched) {
      // Mixed: no single field has every term, but subject and body together do.
      const everywhere = q.tokens.length > 0 && q.tokens.every((t, i) => subject.matches[i] || body.matches[i])
      if (everywhere) {
        candidates.push({ tier: TIER.MIXED, quality: subject.quality + body.quality, source: 'mixed', bodyHits: body.hits })
      }
    }
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.tier - a.tier || b.quality - a.quality)
  return candidates[0]
}

function selectCommit (matches) {
  // Endpoint selection for diff/stat output: keep the existing "one clear winner"
  // semantics. A commit wins outright only when it matched in a strictly stronger
  // tier than the runner-up. Same-tier matches are genuinely ambiguous (even when
  // their quality scores differ), so we surface only the strongest-tier
  // candidates, in history order, for the user to refine.
  if (matches.length === 0) return { kind: 'none' }
  const sorted = byScore(matches)
  if (sorted.length === 1 || sorted[0].tier > sorted[1].tier) {
    return { kind: 'one', commit: sorted[0].commit }
  }
  const topTier = sorted[0].tier
  const tied = sorted.filter(r => r.tier === topTier)
  return { kind: 'ambiguous', results: oldestFirst(tied).slice(0, LIST_LIMIT) }
}

function singleDiffArgs (commit, options, cwd) {
  // `<hash>^!` diffs the commit against its parent, yielding a plain diff without
  // the header/message that `git show` would include. A root commit has no
  // parent, so diff it against this repo's empty tree instead (otherwise
  // `git diff <hash>` would compare against the working tree).
  const args = baseDiffArgs(options)
  if (commit.isRoot) args.push(emptyTree(cwd), commit.hash)
  else args.push(`${commit.hash}^!`)
  return addExcludes(args, options.exclude)
}

function streamDiff (args, cwd, { meta, output }) {
  // Stream git's output so very large diffs are never buffered fully in memory.
  // We count every byte written (including the meta header) so the saved
  // confirmation reports an accurate size.
  //
  // The destination is a file when `output` is a defined path and stdout when it
  // is undefined. We test that sentinel explicitly (never string truthiness) so
  // that no edge case can misroute output.
  //
  // Output guarantees differ by destination:
  //   * a file: written to a unique temp file (in a mkdtemp dir alongside the
  //     requested path, so the final rename stays on the same filesystem and is
  //     atomic) and only renamed into place after git exits cleanly. A failed
  //     run never leaves partial/misleading output at the requested path.
  //   * stdout: streamed raw with no buffering, so if git fails after output
  //     has begun, stdout may already contain partial output. This is
  //     intentional; only a file destination provides the "no partial file"
  //     guarantee.
  const toFile = output !== undefined
  return new Promise((resolve, reject) => {
    let bytes = 0
    let stderr = ''
    let settled = false
    let tmpDir = null
    let dest
    let child = null

    const cleanup = () => {
      if (child) {
        try {
          child.kill()
        } catch {}
      }
      if (dest && dest !== process.stdout) {
        try {
          dest.destroy()
        } catch {}
      }
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true })
        } catch {}
      }
    }
    const fail = err => {
      if (settled) return
      settled = true
      cleanup()
      reject(err instanceof UserError ? err : new UserError(chalk.red(displayError(err))))
    }

    // Set up the destination before spawning git. If creating the temp file
    // fails we return without a running child, so git can never be left blocked
    // on a stdout pipe that nobody is reading.
    if (toFile) {
      try {
        // The temp dir name intentionally does not embed the requested filename:
        // an arbitrary output name can contain control characters that would
        // otherwise leak (unescaped) into filesystem error messages.
        tmpDir = mkdtempSync(join(dirname(output), '.difflog-'))
        dest = createWriteStream(join(tmpDir, 'output'))
      } catch (err) {
        reject(new UserError(chalk.red(`Could not write to ${displayValue(output)}: ${displayError(err)}`)))
        return
      }
    } else {
      dest = process.stdout
    }

    child = spawn('git', args, { cwd })

    // Register error handlers before writing the header or piping git output.
    if (toFile) dest.on('error', err => fail(new UserError(chalk.red(`Could not write to ${displayValue(output)}: ${displayError(err)}`))))
    child.on('error', fail)
    child.stderr.on('data', chunk => {
      stderr += chunk
    })

    if (meta) {
      const header = Buffer.from(meta)
      bytes += header.length
      dest.write(header)
    }
    child.stdout.on('data', chunk => {
      bytes += chunk.length
    })
    child.stdout.pipe(dest, { end: false })

    child.on('close', code => {
      if (settled) return
      if (code !== 0) {
        // Escape git's stderr for display; the diff/stat bytes already streamed
        // to the destination are untouched by this error path.
        fail(new UserError(chalk.red(displayText(stderr.trim()) || `git ${displayText(args.join(' '))} failed`)))
      } else if (!toFile) {
        settled = true
        resolve(bytes)
      } else {
        dest.end(() => {
          try {
            renameSync(join(tmpDir, 'output'), output)
          } catch (err) {
            fail(new UserError(chalk.red(`Could not write to ${displayValue(output)}: ${displayError(err)}`)))
            return
          }
          cleanup()
          settled = true
          resolve(bytes)
        })
      }
    })
  })
}

function tokenize (text) {
  // Split into meaningful, lowercase alphanumeric tokens. Every non-alphanumeric
  // character is a separator, so "fix-i18n-routing", "src/i18n/messages" and
  // "i18n.ts" all expose "i18n" as its own token, while "i18n" itself stays one
  // token (digits are kept). This is what lets us match query terms against real
  // words instead of scattered characters.
  return (text || '').toLowerCase().match(/[a-z0-9]+/g) || []
}

function validateOptions (mode, opts) {
  // Lookup mode produces no diff, so options that only shape diff/stat output are
  // rejected rather than silently ignored. (`--output` cannot be present here: it
  // switches the mode away from lookup.)
  if (mode === 'list') {
    if (opts.from !== undefined) throw requiresOutput('--from')
    if (opts.exclude && opts.exclude.length > 0) throw requiresOutput('--exclude')
    if (opts.meta) throw requiresOutput('--meta')
    if (opts.unified !== undefined) throw requiresOutput('--unified')
  }
  // `--unified` only affects a full patch; it is meaningless with `--stat`.
  if (opts.stat && opts.unified !== undefined) {
    throw new UserError(chalk.red('--unified cannot be combined with --stat.'))
  }
}

function validateRange (start, end, cwd, opts) {
  // An inclusive range only makes sense when start is an ancestor of end (same
  // ancestry path). A commit is its own ancestor, so A === B is allowed.
  if (start.hash === end.hash) return
  if (isAncestor(start.hash, end.hash, cwd)) return
  if (isAncestor(end.hash, start.hash, cwd)) {
    // Suggest the corrected command in the user's own output mode.
    const prefix = rangeCommandPrefix(opts)
    throw new UserError(chalk.red(`${end.short} is earlier than ${start.short}. The range appears reversed.`) + '\n\n' + chalk.gray(`Try:\n  ${prefix} --from ${end.short} -- ${start.short}`))
  }
  throw new UserError(chalk.red(`${start.short} is not an ancestor of ${end.short}.`) + '\n\n' + chalk.gray('Inclusive ranges require the starting and ending commits to be on the same ancestry path.'))
}

// Exit cleanly when a downstream consumer closes the pipe early (e.g.
// `difflog -- query | head`) instead of crashing with an EPIPE stack trace.
process.stdout.on('error', err => {
  if (err.code === 'EPIPE') process.exit(0)
  throw err
})

const program = new Command()

program
  .name('difflog')
  .description('Find commits using typo-tolerant git history search, and optionally output a single-commit or inclusive-range diff.')
  .argument('[query...]', 'search terms (pass after --)')
  .option('-b, --body', 'include commit body in the search')
  .option('-e, --exclude <path...>', 'exclude one or more paths from the diff (repeatable)', (value, previous = []) => previous.concat(value))
  .option('-f, --from <start-query>', 'include changes starting with the matched commit (inclusive range)')
  .option('-m, --meta', 'prepend commit or range metadata to the output')
  .option('-o, --output [file]', 'output a full diff, or set the destination for diff/stat output')
  .option('-s, --stat', 'output diff stat instead of the full patch')
  .option('-u, --unified <lines>', 'number of unified diff context lines')
  .action(async (query, opts) => {
    try {
      await run(query, opts, process.argv.slice(2))
    } catch (err) {
      if (err instanceof UserError) {
        console.error(err.message)
        process.exitCode = 1
        return
      }
      throw err
    }
  })

await program.parseAsync()
