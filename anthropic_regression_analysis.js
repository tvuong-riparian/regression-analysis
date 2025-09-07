/**
 * Anthropic Regression Analysis Script
 *
 * This script analyzes pull request changes for potential regression risks using Claude AI.
 *
 * RATE LIMITING FEATURES (Preserves ALL content within 30,000 input tokens/minute limit):
 * - 12-second delays between API requests for very conservative rate management
 * - Exponential backoff retry logic for 429 rate limit errors
 * - Preserves COMPLETE content: full diffs, current changes, ALL past changes
 * - Real-time token estimation with very conservative 15k/minute threshold
 * - Sequential processing to avoid concurrent request limits
 * - Graceful error handling with specific 30k token limit guidance
 *
 * CONFIGURATION:
 * The script prioritizes maximum analysis quality by preserving ALL code content.
 * This results in slower processing but provides complete context to the AI.
 * Adjust RATE_LIMIT_CONFIG values if you encounter rate limiting issues.
 */

import dotenv from 'dotenv'
import chalk from 'chalk'
import fs from 'fs'
import path from 'path'
import https from 'https'
import { Anthropic } from '@anthropic-ai/sdk'
import { marked } from 'marked'
import { markedTerminal } from 'marked-terminal'
import { keyBy, uniq, chunk } from 'lodash-es'
import { getPullRequestDetails, getPullRequestChangedFiles, getCommitsToFile, getFileChangesInCommit } from './github.js'
import { getJiraTicketsData } from './jira.js'

dotenv.config('./.env')

marked.use(markedTerminal())

// Rate limiting configuration - Preserves ALL content while managing 30k tokens/minute limit
const RATE_LIMIT_CONFIG = {
  delayBetweenRequests: 12000, // 12 seconds between requests (very conservative for full content)
  maxRetries: 3, // Number of retry attempts for rate limit errors
  baseRetryDelay: 20000, // 20 seconds base delay for retries (doubles each retry)
  maxConcurrentRequests: 1, // Process one at a time to avoid rate limits
  maxTokensPerRequest: 6000, // Output tokens limit
  maxCommitMessageLength: 80, // Shorter commit messages to save tokens for full diffs
  maxJiraDescriptionLength: 150, // Shorter Jira descriptions to save tokens for full diffs
  // Keep ALL content - don't truncate diffs, current changes, or past changes
  preserveFullDiffs: true,
  preserveFullCurrentChanges: true,
  preserveAllPastChanges: true,
  // Token estimation (rough): ~1 token per 4 characters
  estimatedTokensPerChar: 0.25,
  targetInputTokensPerRequest: 5000, // Higher target for full content
}

// Sleep utility function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Rough token estimation function
function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(text.length * RATE_LIMIT_CONFIG.estimatedTokensPerChar)
}

// Token usage tracker
let totalTokensUsedThisMinute = 0
let minuteStartTime = Date.now()

// Exponential backoff retry function with enhanced 429 error handling
async function retryWithBackoff(fn, maxRetries = RATE_LIMIT_CONFIG.maxRetries) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      // Check if it's a rate limit error (429 or rate_limit_error)
      const isRateLimit = error.status === 429 ||
                         error.message?.includes('rate_limit') ||
                         error.message?.includes('30,000 input tokens per minute')

      if (isRateLimit) {
        if (attempt === maxRetries) {
          console.error(chalk.red('🚫 Rate limit exceeded after all retries!'))
          console.error(chalk.yellow('💡 Try increasing delayBetweenRequests or reducing token limits in RATE_LIMIT_CONFIG'))
          throw new Error(`Rate limit exceeded after ${maxRetries} retries: ${error.message}`)
        }

        const delay = RATE_LIMIT_CONFIG.baseRetryDelay * Math.pow(2, attempt)
        console.log(chalk.yellow(`⏳ Rate limit hit (30k tokens/minute), retrying in ${delay/1000} seconds...`))
        console.log(chalk.gray(`   Attempt ${attempt + 1}/${maxRetries + 1} - Error: ${error.message?.substring(0, 100)}...`))

        // Reset token counter when we hit rate limit
        totalTokensUsedThisMinute = 0
        minuteStartTime = Date.now()

        await sleep(delay)
        continue
      }

      // If it's not a rate limit error, throw immediately
      throw error
    }
  }
}

// TOneverDO: revisit
// Fix for self-signed certificate issues with Anthropic API (development only)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

// Create custom HTTPS agent for Anthropic API SSL handling
const httpsAgent = new https.Agent({
  rejectUnauthorized: false, // Allow self-signed certificates in development
  // In production, you might want to specify custom CA certificates:
  // ca: fs.readFileSync('path/to/ca-certificate.pem')
})

const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514'
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  // Configure custom HTTPS agent for Anthropic API SSL issues
  httpAgent: httpsAgent,
})

const repo = `RiparianLLC/${process.argv[2]}`

const pullRequestNumber = process.argv[3]

async function getPullRequestChangesSummary(repo, prNumber, baseSha) {
  const pullRequestChangesSummary = []
  const changedFiles = await getPullRequestChangedFiles(repo, prNumber)

  const chunkedChangedFiles = chunk(changedFiles, 10)

  for (const chunk of chunkedChangedFiles) {
    await Promise.all(chunk.map(async (changedFile) => {
      console.log(chalk.cyan(`Fetching past commits of ${changedFile.filename}`))

      const pastCommits = await getCommitsToFile(repo, changedFile.filename, baseSha)
      const currentChanges = changedFile.patch

      const entry = {
        changedFile: changedFile.filename,
        currentChanges,
        pastChanges: [],
      }

      for (const pastCommit of pastCommits) {
        const pastChange = await getFileChangesInCommit(repo, changedFile.filename, pastCommit.sha)
        const jiraTickets = pastCommit.commit.message.match(/RNA-\d+/g) || []

        entry.pastChanges.push({
          jiraTickets,
          commitMessage: pastCommit.commit.message,
          sha: pastCommit.sha,
          diff: pastChange?.patch,
        })
      }

      pullRequestChangesSummary.push(entry)
    }))
  }

  return pullRequestChangesSummary
}

const pullRequestDetails = await getPullRequestDetails(repo, pullRequestNumber)

const pullRequestJiraTickets = pullRequestDetails.title.match(/RNA-\d+/g) || []

const pullRequestChangesSummary = await getPullRequestChangesSummary(repo, pullRequestNumber, pullRequestDetails.base.sha)

const allJiraTickets = uniq([
  ...pullRequestChangesSummary.reduce((acc, entry) => {
    entry.pastChanges.forEach((pastChange) => {
      if (pastChange.jiraTickets) {
        acc.push(...pastChange.jiraTickets)
      }
    })
    return acc
  }, []),
  ...pullRequestJiraTickets,
])

const jiraTicketsData = await getJiraTicketsData(allJiraTickets)

const jiraTicketLookup = keyBy(jiraTicketsData, 'key')

const regressionAnalysis = {
  pullRequestJiraTickets,
  pullRequestChangesSummary,
  jiraTicketDetails: Object.keys(jiraTicketLookup).map(key => ({
    ticketNumber: key,
    description: jiraTicketLookup[key].renderedFields.description,
  })),
}

// Write changesSummary to a file
const outputFileName = `anthropic-regression-analysis-${repo}-pr-${pullRequestNumber}.json`
const outputPath = path.join(import.meta.dirname, outputFileName)

try {
  fs.writeFileSync(outputPath, JSON.stringify(regressionAnalysis, null, 2), 'utf8')
} catch (error) {
  console.error(chalk.red('❌ Error writing changes summary to file:'), error)
  console.log(JSON.stringify(regressionAnalysis, null, 2))
}

console.log(chalk.blue(`📊 Processing ${pullRequestChangesSummary.length} files with rate limiting...`))

for (let i = 0; i < pullRequestChangesSummary.length; i++) {
  const entry = pullRequestChangesSummary[i]

  console.log(chalk.cyan(`\n🔄 Processing file ${i + 1}/${pullRequestChangesSummary.length}: ${entry.changedFile}`))

  // Optimize prompt while preserving full diffs and current changes
  const optimizedEntry = {
    changedFile: entry.changedFile,
    // Preserve full current changes for better analysis
    currentChanges: entry.currentChanges,
    // Preserve all past changes with full diff content
    pastChanges: entry.pastChanges.map(change => ({
      jiraTickets: change.jiraTickets,
      // Truncate only metadata, not the actual code diffs
      commitMessage: change.commitMessage?.substring(0, RATE_LIMIT_CONFIG.maxCommitMessageLength),
      sha: change.sha?.substring(0, 8), // Short SHA
      // Preserve full diff for better analysis
      diff: change.diff,
    })),
  }

  // Estimate token usage for this request
  const promptContent = JSON.stringify(optimizedEntry, null, 2)
  const estimatedInputTokens = estimateTokens(promptContent) + 200 // +200 for system prompt

  // Check if we need to wait to avoid exceeding rate limit
  const now = Date.now()
  if (now - minuteStartTime > 60000) {
    // Reset counter every minute
    totalTokensUsedThisMinute = 0
    minuteStartTime = now
  }

  if (totalTokensUsedThisMinute + estimatedInputTokens > 15000) { // Very conservative 15k limit for full content
    const waitTime = 60000 - (now - minuteStartTime) + 3000 // Wait until next minute + 3s buffer
    console.log(chalk.yellow(`⏳ Approaching token limit (${totalTokensUsedThisMinute + estimatedInputTokens}/30000), waiting ${Math.ceil(waitTime/1000)} seconds...`))
    console.log(chalk.gray(`   Using very conservative limit to preserve ALL content (diffs, changes, history)`))
    await sleep(waitTime)
    totalTokensUsedThisMinute = 0
    minuteStartTime = Date.now()
  }

  totalTokensUsedThisMinute += estimatedInputTokens
  console.log(chalk.gray(`📊 Estimated tokens: ${estimatedInputTokens} (total this minute: ${totalTokensUsedThisMinute}/30000)`))

  const prompt = `
You are a helpful assistant analyzing the changed files in a pull request for potential regression risks.

The following JSON describes the changes made to the file ${entry.changedFile} in the pull request:

${JSON.stringify(optimizedEntry, null, 2)}

The structure of the JSON is as follows:
- pullRequestJiraTickets: The Jira tickets for which the code changes of the pull request are made for
- pullRequestChangesSummary: The list of files that are changed in the pull request. Each file has the following properties:
- changedFile: The name of the file that has been changed in the pull request
- currentChanges: The code changes that have been made to the file in the pull request
    - pastChanges: ALL code changes that have been made to the file in previous commits (complete history with full diffs preserved)
  - jiraTicket: The Jira ticket that the changes are related to (if any)
  - commitMessage: The message of the commit that the changes are related to
  - sha: The SHA of the commit that the changes are related to
  - diff: The diff of the changes that have been made to the file
- jiraTicketDetails: The list of Jira tickets (from pullRequestJiraTickets and pullRequestChangesSummary.pastChanges.jiraTicket) and their descriptions. Use them if you need
to understand the business/historical context of the changes.

ANALYSIS TASK:
1. Identify if the current PR changes affect the same code areas as any historical changes
2. Determine if current changes might undo, contradict, or interfere with previous fixes
3. Look for patterns where:
  - Error handling is being removed or modified
  - Validation logic is being changed
  - Edge case handling is being simplified
  - Defensive programming patterns are being removed

4. Rate regression risk as: HIGH, MEDIUM, LOW, NONE
5. Provide specific evidence for any risks identified

Focus on concrete code relationships rather than speculative concerns.
`

  try {
    // Use retry logic with exponential backoff
    const anthropicResponse = await retryWithBackoff(async () => {
      return await anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: RATE_LIMIT_CONFIG.maxTokensPerRequest,
        messages: [{ role: 'user', content: prompt }],
        system: 'You are a helpful assistant.',
        stream: false,
      })
    })

    console.log(chalk.bold.bgBlue('---------------------------------------------------------------'))
    console.log(chalk.bold.bgBlue(`File: ${entry.changedFile}`))

    console.log(marked(anthropicResponse.content[0].text))

    // Add delay between requests to respect rate limits (except for the last request)
    if (i < pullRequestChangesSummary.length - 1) {
      console.log(chalk.gray(`⏳ Waiting ${RATE_LIMIT_CONFIG.delayBetweenRequests/1000} seconds before next request...`))
      await sleep(RATE_LIMIT_CONFIG.delayBetweenRequests)
    }

  } catch (error) {
    console.error(chalk.red(`❌ Error processing ${entry.changedFile}:`), error.message)

    if (error.message.includes('certificate') || error.message.includes('SSL') || error.message.includes('TLS')) {
      console.error(chalk.yellow('🔒 SSL Certificate Issue with Anthropic API:'))
      console.error(chalk.yellow('   This is likely due to corporate firewall, VPN, or proxy settings.'))
      console.error(chalk.yellow('   The script has been configured to handle self-signed certificates.'))
      console.error(chalk.yellow('   If the issue persists, contact your network administrator.'))
    }

    if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED')) {
      console.error(chalk.yellow('🌐 Network Connection Issue:'))
      console.error(chalk.yellow('   Please check your internet connection and try again.'))
    }

    if (error.message.includes('rate_limit') || error.message.includes('Rate limit exceeded') || error.message.includes('30,000 input tokens')) {
      console.error(chalk.yellow('🚦 Rate Limit Issue (30,000 tokens/minute):'))
      console.error(chalk.yellow('   The script preserves ALL content (full diffs, changes, complete history):'))
      console.error(chalk.yellow('   - Increase delayBetweenRequests (currently 12000ms)'))
      console.error(chalk.yellow('   - Consider processing files in smaller batches'))
      console.error(chalk.yellow('   - The script uses very conservative 15k/minute threshold'))
      console.error(chalk.yellow('   You can modify RATE_LIMIT_CONFIG at the top of the file.'))
    }

    // Continue processing other files instead of stopping completely
    console.log(chalk.yellow(`⏭️  Skipping ${entry.changedFile} and continuing with next file...`))
  }
}
