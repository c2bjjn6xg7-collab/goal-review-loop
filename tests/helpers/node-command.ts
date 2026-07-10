/** Cross-platform subprocess commands for tests (no bash/cmd built-ins). */
export function nodeEval(source: string): string[] {
  return [process.execPath, '-e', source];
}

export function nodeStdout(text: string): string[] {
  return nodeEval(`process.stdout.write(${JSON.stringify(text)})`);
}

export function nodeStderr(text: string): string[] {
  return nodeEval(`process.stderr.write(${JSON.stringify(text)})`);
}

export function nodeExit(code: number): string[] {
  return nodeEval(`process.exit(${code})`);
}

export function nodeSleep(milliseconds = 30_000): string[] {
  return nodeEval(`setTimeout(() => {}, ${milliseconds})`);
}
