const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Whether an otherwise safe identifier cannot be used as a Windows file basename. */
export function isWindowsUnsafeFileName(value: string): boolean {
  return WINDOWS_RESERVED_BASENAME.test(value) || value.endsWith('.') || value.endsWith(' ');
}

/** Windows file lookup is case-insensitive for the ASCII identifier contract. */
export function windowsFileNameKey(value: string): string {
  return value.toLowerCase();
}
