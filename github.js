import { GITHUB_API_HEADERS } from './constants.js'
import { chunk } from 'lodash-es'
import chalk from 'chalk'

export async function getPullRequestDetails(repo, prNumber) {
  const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
    headers: GITHUB_API_HEADERS,
  })

  const data = await response.json()

  return data
}

export async function getPullRequestChangedFiles(repo, prNumber) {
  // Might need to get thru all the pages if there are a lot of files in the PR
  const response = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/files`, {
    headers: GITHUB_API_HEADERS,
  })

  const data = await response.json()

  return data.filter((file) => {
    const shouldExclude = file.filename.startsWith('apps/api/migrations')
      || file.filename.endsWith('spec.ts')
      || file.status === 'added'

    if (shouldExclude) {
      return false
    }

    return true
  })
}

export async function getCommitsToFile(repo, filePath, baseSha) {
  const allCommits = []
  let page = 1

  while (true) {
    const response = await fetch(`https://api.github.com/repos/${repo}/commits?path=${filePath}&per_page=100&page=${page}&sha=${baseSha}`, {
      headers: GITHUB_API_HEADERS,
    })

    const commits = await response.json()

    commits.forEach((commitObject) => {
      const commit = commitObject.commit

      if (
        commit.message.startsWith("Merge branch 'develop' into")
        || commit.message.startsWith("Merge branch 'LRB")
        || commit.message.startsWith("Merge remote-tracking branch 'origin/develop'")
        || commit.message.startsWith('Merge pull request')
      ) {
        return
      }

      allCommits.push(commitObject)
    })

    page += 1

    if (commits.length === 0) {
      // No more commits found
      break
    }
  }

  return allCommits
}

export async function getFileChangesInCommit(repo, filePath, sha) {
  const response = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}`, {
    headers: GITHUB_API_HEADERS,
  })

  const data = await response.json()

  return (data.files || []).filter((file) => file.filename === filePath)[0]
}

export async function getPullRequestChangesSummary(repo, prNumber, baseSha) {
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
        // TODO: make regex dynamic
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
