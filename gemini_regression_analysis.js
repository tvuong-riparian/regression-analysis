import { keyBy, uniq } from 'lodash-es'
import { getPullRequestDetails, getPullRequestChangesSummary } from './github.js'
import { getJiraTicketsData } from './jira.js'
import chalk from 'chalk'
import fs from 'fs'
import path from 'path'
import { GoogleGenAI } from '@google/genai'

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

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
  })

  console.log(response.text)
}
