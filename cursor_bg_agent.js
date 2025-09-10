import { keyBy, uniq } from 'lodash-es'
import { getPullRequestDetails, getPullRequestChangesSummary } from './github.js'
import { getJiraTicketsData } from './jira.js'
import chalk from 'chalk'
import fs from 'fs'
import path from 'path'
import { marked } from 'marked'
import { markedTerminal } from 'marked-terminal'
import dotenv from 'dotenv'

dotenv.config('./.env')

marked.use(markedTerminal())

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

// Main

// TODO: take from args
const repo = 'tvuong-riparian/rna'

const pullRequestNumber = 3

const llmModel = 'claude-4-sonnet'

// Write changesSummary to a file
const outputFileName = `regression-analysis-${encodeURIComponent(repo)}-pr-${pullRequestNumber}.json`
const outputPath = path.join(import.meta.dirname, outputFileName)

async function getPullRequestChangesSummaryFile() {
  const pullRequestDetails = await getPullRequestDetails(repo, pullRequestNumber)

//console.log(chalk.blue(`🤖 Pull Request Details: ${JSON.stringify(pullRequestDetails, null, 2)}`))

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

try {
  fs.writeFileSync(outputPath, JSON.stringify(regressionAnalysis, null, 2), 'utf8')
} catch (error) {
  console.error(chalk.red('❌ Error writing changes summary to file:'), error)
  console.log(JSON.stringify(regressionAnalysis, null, 2))
}

console.log(chalk.blue(`\n🚀 Starting regression analysis for ${pullRequestChangesSummary.length} files...`))
}

await getPullRequestChangesSummaryFile()

// Read the regression analysis file content
let regressionAnalysisContent = '';
try {
  regressionAnalysisContent = fs.readFileSync(outputPath, 'utf8');
} catch (error) {
  console.error(chalk.red('❌ Error reading regression analysis file:'), error);
  process.exit(1);
}

const prompt = `
You are a helpful assistant analyzing the changed files in a pull request for potential regression risks.

Here is the regression analysis data for pull request #${pullRequestNumber} of the repo ${repo}:

\`\`\`json
${regressionAnalysisContent}
\`\`\`

The structure of the data (JSON) is as follows:
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

RULES:

- READ-ONLY. Do NOT commit, open PRs, or post comments.
- Analyze only; produce a final JSON result via your response (not a commit).
`

const modelsResp = await fetch('https://api.cursor.com/v0/models', {
  headers: {
    Authorization: `Bearer ${process.env.CURSOR_API_KEY}`,
    'Content-Type': 'application/json',
  },
})

const modelsRespJson = await modelsResp.json()

console.log(chalk.green(`🤖 Models: ${JSON.stringify(modelsRespJson, null, 2)}`))

const resp = await fetch('https://api.cursor.com/v0/agents', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.CURSOR_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    prompt: {
      text: prompt,
    },
    source: {
      repository: `https://github.com/${repo}`,
      ref: 'develop',
    },
    model: llmModel,
  }),
})

const respJson = await resp.json()

console.log(chalk.green(`🤖 Agent Response: ${JSON.stringify(respJson, null, 2)}`))

const agentId = respJson.id

console.log(chalk.green(`🤖 Agent ID: ${agentId}`))

const agentResp = await fetch(`https://api.cursor.com/v0/agents/${agentId}/responses`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.CURSOR_API_KEY}`,
    'Content-Type': 'application/json',
  },
})

const agentRespJson = await agentResp.json()

console.log(chalk.green(`🤖 Agent Response: ${JSON.stringify(agentRespJson, null, 2)}`))
