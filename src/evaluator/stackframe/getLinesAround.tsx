import {ScriptLine} from './stack-frame'

/**
 *
 * @param {number} line The line number to provide context around.
 * @param {number} count The number of lines you'd like for context.
 * @param {string[] | string} lines The source code.
 */
export function getLinesAround(
  line: number,
  count: number,
  lines: string[] | string,
): ScriptLine[] {
  if (typeof lines === 'string') {
    lines = lines.split('\n')
  }
  const result = [] as ScriptLine[]
  for (
    let index = Math.max(0, line - 1 - count);
    index <= Math.min(lines.length - 1, line - 1 + count);
    ++index
  ) {
    result.push({
      lineNumber: index + 1,
      content: lines[index],
      highlight: index === line - 1,
    })
  }
  return result
}
