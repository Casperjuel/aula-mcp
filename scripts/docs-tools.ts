// Rewrites docs/tools.md from the tool catalog. tool-catalog.test.ts fails
// when the file is out of date.
import { writeFile } from 'node:fs/promises';
import { renderToolsMarkdown, toolCatalog } from '../packages/mcp-server/src/tool-catalog.ts';

await writeFile(new URL('../docs/tools.md', import.meta.url), renderToolsMarkdown(toolCatalog({})));
