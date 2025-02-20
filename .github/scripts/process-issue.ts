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
  return genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
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
  const timestamp = new Date().getTime();
  return `voyager/issue-${issueNumber}-${timestamp}`;
}

async function parseGeminiResponse(response: string): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  const fileBlocks = response.split('```').filter((_, i) => i % 2 === 1);

  for (const block of fileBlocks) {
    const lines = block.split('\n');
    let path = '';
    let content = '';

    // Skip empty blocks
    if (lines.length < 2) continue;

    // Check for language:filepath pattern first
    const firstLine = lines[0].trim();
    const langPathMatch = firstLine.match(/^(?:typescript|javascript|tsx?|jsx?):?(.+)?$/);

    if (langPathMatch && langPathMatch[1]) {
      path = langPathMatch[1].trim();
      content = lines.slice(1).join('\n');
    } else {
      // If no language:filepath pattern, look for the path in the first non-empty line
      const pathLine = lines.find(line =>
        line.trim() &&
        !line.startsWith('```') &&
        (
          line.includes('/') ||
          line.endsWith('.tsx') ||
          line.endsWith('.ts') ||
          line.startsWith('src/')
        )
      );
      if (pathLine) {
        path = pathLine.trim();
        content = lines
          .filter(line =>
            line.trim() &&
            line !== pathLine &&
            !line.match(/^(typescript|javascript|tsx?|jsx?):?$/)
          )
          .join('\n')
          .trim();
      }
    }

    // Validate we have both path and non-empty content
    if (path && content.trim()) {
      changes.push({ path, content });
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
      
      CRITICAL INSTRUCTIONS:
      1. Only make changes that directly address the issue requirements
      2. Preserve existing code structure and functionality unless the issue specifically requests changes
      3. Keep all imports and dependencies unless modifications are requested
      4. Maintain code style and formatting
      5. If adding new code, follow the existing patterns
      
      Provide specific file changes that should be made to address this issue.
      Format your response using markdown code blocks. Each block MUST start with the file path on its own line, like this:
      
      \`\`\`typescript
      src/App.tsx
      // file content here
      \`\`\`
      
      For each change:
      1. Explain why the change is needed
      2. Show the complete file content
      3. If multiple files need changes, explain their relationships
      4. If new files are needed, explain their purpose
      
      IMPORTANT: Provide the complete file content, not just the changed parts.
      Do not:
      - Remove any imports unless specifically requested
      - Delete any files
      - Modify styles unless requested
      - Make unrelated changes
      - Modify more files than necessary
      
      Focus on React components, TypeScript types, and related frontend code.
      Be specific about file paths and ensure they match the typical Vite + React project structure.
      Always include all imports and the complete file contents.
      The file path must be a valid path like 'src/App.tsx' or 'src/components/Counter.tsx'.
      
      Before suggesting changes:
      1. Analyze what minimal changes are needed to address the issue
      2. Consider impact on other files and components
      3. Maintain existing functionality unless changes are requested
      4. Follow React and TypeScript best practices
    `;

    // Validate file changes before applying them
    function validateFileChanges(changes: FileChange[]): FileChange[] {
      return changes.filter(change => {
        // Basic validation
        if (!change.path || !change.content) {
          console.log('Invalid change: missing path or content');
          return false;
        }

        // Skip path validation for imports
        const isImportPath = change.path.startsWith('import ');
        if (!isImportPath && !change.path.startsWith('src/')) {
          console.log(`Invalid path: ${change.path} - must be within src/`);
          return false;
        }

        // Don't allow changes to certain file types unless explicitly mentioned
        const sensitiveExtensions = ['.css', '.json', '.md', '.env'];
        const ext = isImportPath ? '' : path.extname(change.path);
        if (sensitiveExtensions.includes(ext) && !body.toLowerCase().includes(ext)) {
          console.log(`Skipping ${ext} file change as it wasn't explicitly requested`);
          return false;
        }

        return true;
      });
    }

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
    const fileChanges = validateFileChanges(await parseGeminiResponse(suggestedChanges));

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