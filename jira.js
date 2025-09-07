import { JIRA_API_HEADERS } from './constants.js'
import { uniq } from 'lodash-es'

export async function getJiraTicketsData(jiraTickets) {
  if (jiraTickets.length === 0) {
    return []
  }

  // Properly format JQL query with quoted ticket keys
  const quotedTickets = uniq(jiraTickets).map(ticket => `"${ticket}"`).join(', ')
  const jqlQuery = `project = RNA AND key IN (${quotedTickets})`

  // URL encode the JQL query
  const encodedJQL = encodeURIComponent(jqlQuery)

  const response = await fetch(`https://riparianllc.atlassian.net/rest/api/3/search/jql?jql=${encodedJQL}&expand=names,renderedFields&fields=summary,description,priority`, {
    headers: JIRA_API_HEADERS,
  })

  if (!response.ok) {
    console.error('JIRA API Error:', response.status, response.statusText)
    const errorData = await response.text()
    console.error('Error details:', errorData)
    throw new Error(`JIRA API error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()

  return data.issues
}
