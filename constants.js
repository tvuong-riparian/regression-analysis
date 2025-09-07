import dotenv from 'dotenv'

dotenv.config('./.env')

export const REPO = 'RiparianLLC/rna'
export const GITHUB_API_HEADERS = {
  'Authorization': `Bearer ${process.env.GITHUB_API_TOKEN}`,
  'Accept': 'application/vnd.github.v3+json',
}
export const JIRA_API_HEADERS = {
  'Authorization': `Basic ${Buffer.from(`${process.env.JIRA_USERNAME}:${process.env.JIRA_API_TOKEN}`).toString('base64')}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json',
}
