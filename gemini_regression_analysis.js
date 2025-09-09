import { keyBy, uniq } from 'lodash-es'
import { getPullRequestDetails, getPullRequestChangesSummary } from './github.js'
import { getJiraTicketsData } from './jira.js'
import chalk from 'chalk'
import fs from 'fs'
import path from 'path'
import { GoogleGenAI } from '@google/genai'
import { marked } from 'marked'
import { markedTerminal } from 'marked-terminal'
import dotenv from 'dotenv'

dotenv.config('./.env')

marked.use(markedTerminal())

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
})

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

// Main
const repo = process.argv[2]

const pullRequestNumber = process.argv[3]

const pullRequestDetails = await getPullRequestDetails(repo, pullRequestNumber)

// TODO: make regex dynamic
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
const outputFileName = `regression-analysis-${encodeURIComponent(repo)}-pr-${pullRequestNumber}.json`
const outputPath = path.join(import.meta.dirname, outputFileName)

try {
  fs.writeFileSync(outputPath, JSON.stringify(regressionAnalysis, null, 2), 'utf8')
} catch (error) {
  console.error(chalk.red('❌ Error writing changes summary to file:'), error)
  console.log(JSON.stringify(regressionAnalysis, null, 2))
}

console.log(chalk.blue(`\n🚀 Starting regression analysis for ${pullRequestChangesSummary.length} files...`))
console.log(chalk.gray(`💡 Using Gemini API with automatic rate limit handling and retries`))

for (let i = 0; i < pullRequestChangesSummary.length; i++) {
  const entry = pullRequestChangesSummary[i]

  console.log(chalk.cyan(`\n🔄 Processing file ${i + 1}/${pullRequestChangesSummary.length}: ${entry.changedFile}`))

  const promptEntry = {
    changedFile: entry.changedFile,
    // Preserve full current changes for better analysis
    currentChanges: entry.currentChanges,
    // Preserve all past changes with full diff content
    pastChanges: entry.pastChanges.map(change => ({
      jiraTickets: change.jiraTickets,
      // Truncate only metadata, not the actual code diffs
      commitMessage: change.commitMessage,
      sha: change.sha?.substring(0, 8), // Short SHA
      // Preserve full diff for better analysis
      diff: change.diff,
    })),
  }

  const prompt = `
You are a helpful assistant analyzing the changed files in a pull request for potential regression risks.

The following JSON describes the changes made to the file ${entry.changedFile} in the pull request:

${JSON.stringify(promptEntry, null, 2)}

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

  // Estimate token count for the prompt
  const estimatedTokens = estimateTokens(prompt)
  console.log(chalk.gray(`📊 Estimated tokens: ${estimatedTokens.toLocaleString()}`))

  // Warn if approaching free tier limits
  if (estimatedTokens > 200000) {
    console.log(chalk.yellow(`⚠️  Large prompt detected (${estimatedTokens.toLocaleString()} tokens). This may hit rate limits.`))
  }

  try {
    const response = await retryWithBackoff(
      async () => {
        return await ai.models.generateContent({
          model: "gemini-2.5-flash",
          contents: prompt,
        })
      },
      5, // max retries
      `File ${i + 1}/${pullRequestChangesSummary.length}: ${entry.changedFile}`
    )

    console.log(marked(response.text))

  } catch (error) {
    console.error(chalk.red(`❌ Failed to analyze ${entry.changedFile} after all retries:`))
    console.error(chalk.red(error.message))

    // Log the error details for debugging
    if (error?.error?.code === 429) {
      console.error(chalk.yellow(`💡 This was a rate limit error. Consider:
        - Reducing prompt size
        - Adding longer delays between requests
        - Upgrading to a paid tier for higher limits`))
    }

    // Continue with next file instead of crashing
    console.log(chalk.yellow(`⏭️  Skipping to next file...`))
  }

  // Reduced sleep time since we now have proper rate limiting
  // Free tier: 15 requests per minute, so ~4 seconds between requests
  await sleep(4000)
}

// Retry wrapper for Gemini API calls with rate limit handling
export async function retryWithBackoff(apiCall, maxRetries = 5, context = '') {
  let lastError = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await apiCall()
      if (attempt > 0) {
        console.log(`✅ ${context} succeeded after ${attempt} retries`)
      }
      return result
    } catch (error) {
      lastError = error

      // Check if it's a rate limit error (429)
      const isRateLimit = error?.error?.code === 429 ||
                         error?.status === 429 ||
                         error?.message?.includes('429') ||
                         error?.message?.includes('rate limit') ||
                         error?.message?.includes('quota')

      if (!isRateLimit) {
        // Not a rate limit error, don't retry
        throw error
      }

      if (attempt === maxRetries) {
        console.error(`❌ ${context} failed after ${maxRetries} retries`)
        throw error
      }

      // Calculate delay
      let delay
      const apiRetryDelay = extractRetryDelay(error)

      if (apiRetryDelay) {
        // Use API-suggested delay plus some buffer
        delay = apiRetryDelay + 1000 // Add 1 second buffer
        console.log(`⏳ ${context} rate limited. Using API suggested delay: ${apiRetryDelay/1000}s + 1s buffer`)
      } else {
        // Use exponential backoff
        delay = calculateBackoffDelay(attempt)
        console.log(`⏳ ${context} rate limited. Using exponential backoff: ${delay/1000}s`)
      }

      console.log(`🔄 Attempt ${attempt + 1}/${maxRetries + 1} failed. Retrying in ${delay/1000}s...`)
      await sleep(delay)
    }
  }

  throw lastError
}

// Sleep utility function
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Rough token estimation for text (approximate)
function estimateTokens(text) {
  // Very rough estimation: ~4 characters per token for English text
  // This is conservative - actual tokens may vary
  return Math.ceil(text.length / 4)
}

// Extract retry delay from Gemini API error response
function extractRetryDelay(error) {
  try {
    if (error?.error?.details) {
      const retryInfo = error.error.details.find(detail =>
        detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
      )
      if (retryInfo?.retryDelay) {
        // Convert "4s" to milliseconds
        const seconds = parseInt(retryInfo.retryDelay.replace('s', ''))
        return seconds * 1000
      }
    }
  } catch (e) {
    // Ignore parsing errors
  }
  return null
}

// Exponential backoff with jitter
export function calculateBackoffDelay(attempt, baseDelay = 1000, maxDelay = 60000) {
  const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay)
  // Add jitter (±25% randomization) to avoid thundering herd
  const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1)
  return Math.max(1000, exponentialDelay + jitter) // Minimum 1 second
}

