import { GoogleGenerativeAI } from '@google/generative-ai';
import { Octokit } from '@octokit/rest';
import { readFile } from 'fs/promises';
import path from 'path';

interface GithubEvent {
  issue: {
    number: number;
    title: string;
    body: string;
  };
}

interface FileChange {
  path: string;
  content: string;
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

async function parseGeminiResponse(response: string): Promise<FileChange[]> {
  // This is a simple parser - you might want to make it more robust
  const changes: FileChange[] = [];
  const fileBlocks = response.split('```').filter((_, i) => i % 2 === 1);

  for (const block of fileBlocks) {
    const lines = block.split('\n');
    const firstLine = lines[0];

    // Look for language:filepath pattern (e.g., "typescript:src/App.tsx" or "ts:src/App.tsx")
    const match = firstLine.match(/^(?:\w+:)?(.+)$/);
    if (match) {
      const filePath = match[1].trim();
      const content = lines.slice(1).join('\n');
      changes.push({ path: filePath, content });
    }
  }

  return changes;
}

async function main() {
  try {
    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });

    const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
    const { title, body, number: issueNumber } = await getIssueContent();
    const model = await setupGemini();

    const prompt = `
      Based on the following issue, suggest code changes for a Vite React TypeScript application:
      
      Title: ${title}
      Description: ${body}
      
      Provide specific file changes that should be made to address this issue.
      Format your response using markdown code blocks with the file path in the first line.
      IMPORTANT: Provide the complete file content, not just the changed parts.
      Do not use ellipsis (...) or placeholders like "remaining code".
      Example:
      \`\`\`typescript:src/components/Example.tsx
      import React from 'react';
      
      export const Example = () => {
        return <div>Complete component code here</div>;
      };
      
      export default Example;
      \`\`\`
      
      Focus on React components, TypeScript types, and related frontend code.
      Be specific about file paths and ensure they match the typical Vite + React project structure.
      Always include all imports and the complete file contents.
    `;

    const result = await model.generateContent(prompt);
    const suggestedChanges = result.response.text();

    // Get default branch first
    const { data: repoData } = await octokit.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch;

    // Create new branch
    const branchName = createBranchName(issueNumber);
    const { data: refData } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${defaultBranch}`,
    });

    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: refData.object.sha,
    });

    // Parse and apply changes
    const fileChanges = await parseGeminiResponse(suggestedChanges);

    for (const change of fileChanges) {
      try {
        // Get current file content and SHA
        const { data: fileData } = await octokit.repos.getContent({
          owner,
          repo,
          path: change.path,
          ref: defaultBranch,
        });

        if ('content' in fileData && 'sha' in fileData) {
          // Update file
          await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: change.path,
            message: `Update ${change.path} as per issue #${issueNumber}`,
            content: Buffer.from(change.content).toString('base64'),
            branch: branchName,
            sha: fileData.sha
          });
        }
      } catch (error) {
        console.error(`Error updating ${change.path}:`, error);
      }
    }

    // Create PR if any changes were made
    if (fileChanges.length > 0) {
      const { data: pr } = await octokit.pulls.create({
        owner,
        repo,
        title: `Fix for: ${title}`,
        body: `Addresses issue #${issueNumber}\n\nSuggested changes:\n\n${suggestedChanges}`,
        head: branchName,
        base: defaultBranch,
      });

      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body: `I've created PR #${pr.number} with suggested changes.`,
      });
    } else {
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body: `I couldn't determine any specific file changes from the AI response. Please provide more details.`,
      });
    }

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main(); 