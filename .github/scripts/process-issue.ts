import { GoogleGenerativeAI } from '@google/generative-ai';
import { Octokit } from '@octokit/rest';
import { readFile } from 'fs/promises';

interface GithubEvent {
  issue: {
    number: number;
    title: string;
    body: string;
  };
}

async function setupGemini() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return genAI.getGenerativeModel({ model: 'gemini-pro' });
}

async function getIssueContent(): Promise<{ title: string; body: string; number: number }> {
  const eventPath = process.env.GITHUB_EVENT_PATH!;
  const eventData = JSON.parse(await readFile(eventPath, 'utf8')) as GithubEvent;
  return {
    title: eventData.issue.title,
    body: eventData.issue.body,
    number: eventData.issue.number,
  };
}

function createBranchName(issueNumber: number): string {
  return `voyager/issue-${issueNumber}`;
}

async function main() {
  try {
    // Initialize GitHub client
    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });

    const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');

    // Get issue content
    const { title, body, number: issueNumber } = await getIssueContent();

    // Setup Gemini
    const model = await setupGemini();

    // Prepare prompt for Gemini
    const prompt = `
      Based on the following issue, suggest code changes for a Vite React TypeScript application:
      
      Title: ${title}
      Description: ${body}
      
      Provide specific file changes that should be made to address this issue.
      Format your response as a list of file changes with paths and content.
      Focus on React components, TypeScript types, and related frontend code.
    `;

    // Get suggestion from Gemini
    const result = await model.generateContent(prompt);
    const suggestedChanges = result.response.text();

    // Get default branch
    const { data: repoData } = await octokit.repos.get({
      owner,
      repo,
    });

    const defaultBranch = repoData.default_branch;

    // Get the SHA of the default branch
    const { data: refData } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
    });

    const branchName = createBranchName(issueNumber);

    // Create new branch
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: refData.object.sha,
    });

    // Create PR
    const { data: pr } = await octokit.pulls.create({
      owner,
      repo,
      title: `Fix for: ${title}`,
      body: `Addresses issue #${issueNumber}\n\nSuggested changes:\n\n${suggestedChanges}`,
      head: branchName,
      base: defaultBranch,
    });

    // Add comment to the issue
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: `I've created PR #${pr.number} with suggested changes.`,
    });

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main(); 