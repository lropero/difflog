#!/usr/bin/env node

import chalk from 'chalk'
import { basename, dirname, join } from 'node:path'
import { Command } from 'commander'
import { createWriteStream, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'

// Unit/record separators are extremely unlikely to appear in commit metadata,
// so we use them to split `git log` output into fields and records.
const FIELD = '\x1f'
const RECORD = '\x1e'

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
// Relative strength of a single term-vs-token match, used for tie-breaking.
const KIND_RANK = { exact: 3, prefix: 2, typo: 1 }
// How many candidates to show when the result is ambiguous.
const LIST_LIMIT = 10
// Shortest query length we are willing to treat as a (possibly partial) hash.
const MIN_HASH_LEN = 4

class UserError extends Error {}

function tokenize (text) {
  // Split into meaningful, lowercase alphanumeric tokens. Every non-alphanumeric
  // character is a separator, so "fix-i18n-routing", "src/i18n/messages" and
  // "i18n.ts" all expose "i18n" as its own token, while "i18n" itself stays one
  // token (digits are kept). This is what lets us match query terms against real
  // words instead of scattered characters.
  return (text || '').toLowerCase().match(/[a-z0-9]+/g) || []
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
    if (/^[a-z0-9]+$/i.test(part) && matched.has(part.toLowerCase())) out += chalk.cyan(part)
    else out += chalk.gray(part)
  }
  const prefix = start > 0 ? chalk.gray('...') : ''
  const suffix = end < body.length ? chalk.gray('...') : ''
  return prefix + out + suffix
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

function chooseCommit (commits, q, useBody) {
  const scored = []
  for (const commit of commits) {
    const match = scoreCommit(commit, q, useBody)
    if (match) scored.push({ commit, ...match })
  }
  if (scored.length === 0) return { kind: 'none' }

  scored.sort((a, b) => b.tier - a.tier || b.quality - a.quality)
  // One clear winner only when it matched in a strictly stronger way than the
  // runner-up. Same-tier matches are genuinely ambiguous, so we ask to refine.
  if (scored.length === 1 || scored[0].tier > scored[1].tier) {
    return { kind: 'one', commit: scored[0].commit }
  }
  return { kind: 'ambiguous', results: scored.slice(0, LIST_LIMIT) }
}

function commitMeta (commit, cwd) {
  // A small, plain (uncolored) header useful when saving a diff for review.
  const out = git(['show', '-s', '--date=iso', `--format=${['%an', '%ae', '%ad'].join(FIELD)}`, commit.hash], cwd)
  const [name, email, date] = out.trim().split(FIELD)
  const lines = [`commit ${commit.hash} (${commit.short})`]
  if (name) lines.push(`Author: ${name}${email ? ` <${email}>` : ''}`)
  if (date) lines.push(`Date: ${date}`)
  lines.push(`Subject: ${commit.subject}`)
  return lines.join('\n') + '\n\n'
}

function diffArgs (commit, { exclude, stat, unified }, cwd) {
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
  return args
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

async function run (query, opts) {
  if (!query || query.length === 0) {
    throw new UserError(chalk.red('Missing search terms.') + '\n' + chalk.gray('Pass them after -- so they are not consumed by --exclude.\nUsage: difflog [options] -- <search terms>\nExample: difflog -e package-lock.json -o diff.txt -- JIRA-123 mobile'))
  }

  const cwd = repoRoot()
  const commits = loadCommits(cwd, { body: opts.body })
  if (commits.length === 0) {
    throw new UserError(chalk.red('This repository has no commits yet.'))
  }

  const q = prepareQuery(query)
  const unified = opts.unified === undefined ? undefined : parseUnified(opts.unified)

  const outcome = chooseCommit(commits, q, opts.body)

  if (outcome.kind === 'none') {
    const hint = opts.body ? 'Try different search terms.' : 'Try different search terms, or -b/--body to also search commit message bodies.'
    throw new UserError(chalk.red(`No commits matched "${q.text}".`) + ' ' + chalk.gray(hint))
  }

  if (outcome.kind === 'ambiguous') {
    const lines = outcome.results.map((r, i) => {
      let row = `  ${i + 1}. ${chalk.cyan(r.commit.short)}  ${r.commit.subject}`
      // The short hash and subject are already visible in the row, so only add an
      // explanation line when the body (not the subject/hash) is what matched.
      if ((r.source === 'body' || r.source === 'mixed') && r.bodyHits && r.bodyHits.length > 0) {
        const excerpt = bodyExcerpt(r.commit.body, r.bodyHits)
        if (excerpt) row += '\n     ' + chalk.gray('body: ') + excerpt
      }
      return row
    })
    throw new UserError(chalk.yellow(`Multiple commits matched "${q.text}". Refine your search:`) + '\n' + lines.join('\n'))
  }

  const commit = outcome.commit

  if (commit.isMerge) {
    throw new UserError(chalk.yellow(`${chalk.cyan(commit.short)} (${commit.subject}) is a merge commit.`) + '\n' + chalk.gray(`The diff for a merge is ambiguous in this tool; inspect it directly, e.g.:\n  git show ${commit.short}\n  git show --first-parent ${commit.short}`))
  }

  const args = diffArgs(commit, { exclude: opts.exclude, stat: opts.stat, unified }, cwd)
  const meta = opts.meta ? commitMeta(commit, cwd) : ''
  const bytes = await streamDiff(args, cwd, { meta, output: opts.output })

  if (opts.output) {
    const kind = opts.stat ? 'stat' : 'diff'
    console.log(chalk.green(`Saved ${kind} for `) + chalk.cyan(commit.short) + chalk.green(` -> ${commit.subject} to ${opts.output} `) + chalk.gray(`(${bytes} bytes)`))
  }
}

function streamDiff (args, cwd, { meta, output }) {
  // Stream git's output so very large diffs are never buffered fully in memory.
  // We count every byte written (including the meta header) so the saved
  // confirmation reports an accurate size.
  //
  // Output guarantees differ by destination:
  //   * -o: written to a unique temp file (in a mkdtemp dir alongside the
  //     requested path, so the final rename stays on the same filesystem and is
  //     atomic) and only renamed into place after git exits cleanly. A failed
  //     run never leaves partial/misleading output at the requested path.
  //   * stdout: streamed raw with no buffering, so if git fails after output
  //     has begun, stdout may already contain partial output. This is
  //     intentional; only -o provides the "no partial requested file" guarantee.
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
      reject(err instanceof UserError ? err : new UserError(chalk.red(err.message)))
    }

    // Set up the destination before spawning git. If creating the temp file
    // fails we return without a running child, so git can never be left blocked
    // on a stdout pipe that nobody is reading.
    if (output) {
      try {
        tmpDir = mkdtempSync(join(dirname(output), `.difflog-${basename(output)}-`))
        dest = createWriteStream(join(tmpDir, 'output'))
      } catch (err) {
        reject(new UserError(chalk.red(`Could not write to ${output}: ${err.message}`)))
        return
      }
    } else {
      dest = process.stdout
    }

    child = spawn('git', args, { cwd })

    // Register error handlers before writing the header or piping git output.
    if (output) dest.on('error', err => fail(new UserError(chalk.red(`Could not write to ${output}: ${err.message}`))))
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
        fail(new UserError(chalk.red(stderr.trim() || `git ${args.join(' ')} failed`)))
      } else if (!output) {
        settled = true
        resolve(bytes)
      } else {
        dest.end(() => {
          try {
            renameSync(join(tmpDir, 'output'), output)
          } catch (err) {
            fail(new UserError(chalk.red(`Could not write to ${output}: ${err.message}`)))
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

// Exit cleanly when a downstream consumer closes the pipe early (e.g.
// `difflog -- query | head`) instead of crashing with an EPIPE stack trace.
process.stdout.on('error', err => {
  if (err.code === 'EPIPE') process.exit(0)
  throw err
})

const program = new Command()

program
  .name('difflog')
  .description('Find a commit by typo-tolerant search over git history and print or save its diff.')
  .argument('[query...]', 'search terms (pass after --)')
  .option('-b, --body', 'include commit body in the search')
  .option('-e, --exclude <path...>', 'exclude one or more paths from the diff (repeatable)', (value, previous = []) => previous.concat(value))
  .option('-m, --meta', 'prepend a commit metadata header to the output')
  .option('-o, --output <file>', 'write diff output to a file')
  .option('-s, --stat', 'output diff stat instead of the full patch')
  .option('-u, --unified <lines>', 'number of unified diff context lines')
  .action(async (query, opts) => {
    try {
      await run(query, opts)
    } catch (err) {
      if (err instanceof UserError) {
        console.error(err.message)
        process.exitCode = 1
        return
      }
      throw err
    }
  })

program.parseAsync()
