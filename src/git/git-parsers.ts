export interface StatusEntry {
  x: string;
  y: string;
  path: string;
  orig_path?: string;
}

function unquotePath(path: string): string {
  if (path.startsWith('"') && path.endsWith('"')) {
    const unquoted = path.slice(1, -1);
    
    const bytes: number[] = [];
    let i = 0;
    while (i < unquoted.length) {
      if (unquoted[i] === '\\' && i + 1 < unquoted.length) {
        const next = unquoted[i + 1];
        switch (next) {
          case 'a': bytes.push(0x07); i += 2; break;
          case 'b': bytes.push(0x08); i += 2; break;
          case 't': bytes.push(0x09); i += 2; break;
          case 'n': bytes.push(0x0a); i += 2; break;
          case 'v': bytes.push(0x0b); i += 2; break;
          case 'f': bytes.push(0x0c); i += 2; break;
          case 'r': bytes.push(0x0d); i += 2; break;
          case '"': bytes.push(0x22); i += 2; break;
          case "'": bytes.push(0x27); i += 2; break;
          case '\\': bytes.push(0x5c); i += 2; break;
          default:
            if (next >= '0' && next <= '7' && i + 3 < unquoted.length) {
              const octal = unquoted.slice(i + 1, i + 4);
              bytes.push(parseInt(octal, 8));
              i += 4;
            } else {
              bytes.push(unquoted.charCodeAt(i));
              i++;
            }
            break;
        }
      } else {
        bytes.push(unquoted.charCodeAt(i));
        i++;
      }
    }
    
    return Buffer.from(bytes).toString('utf8');
  }
  return path;
}

export function parsePorcelainStatus(output: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const lines = output.split('\n').filter((line) => line.length > 0);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('#')) {
      i++;
      continue;
    }

    if (line.length < 3) {
      i++;
      continue;
    }

    const x = line[0];
    const y = line[1];
    const path = unquotePath(line.slice(3));

    if ((x === 'R' || x === 'C') && i + 1 < lines.length) {
      entries.push({
        x,
        y,
        path: unquotePath(lines[i + 1]),
        orig_path: path,
      });
      i += 2;
    } else {
      entries.push({
        x,
        y,
        path,
      });
      i++;
    }
  }

  return entries;
}

export interface NameStatusEntry {
  status: string;
  path: string;
  orig_path?: string;
}

export function parseNameStatus(output: string): NameStatusEntry[] {
  const entries: NameStatusEntry[] = [];
  const lines = output.split('\0').filter((line) => line.length > 0);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const status = line.trim();

    if (status.startsWith('R') || status.startsWith('C')) {
      if (i + 2 < lines.length) {
        entries.push({
          status,
          path: lines[i + 2],
          orig_path: lines[i + 1],
        });
        i += 3;
      } else {
        i++;
      }
    } else if (status.length === 1 && /^[MAD]$/.test(status)) {
      if (i + 1 < lines.length) {
        entries.push({
          status,
          path: lines[i + 1],
        });
        i += 2;
      } else {
        i++;
      }
    } else {
      const parts = line.split('\t');
      if (parts.length >= 2) {
        entries.push({
          status: parts[0].trim(),
          path: parts[1],
        });
      }
      i++;
    }
  }

  return entries;
}

export interface NumstatEntry {
  additions: number | null;
  deletions: number | null;
  path: string;
}

export function parseNumstat(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  const lines = output.split('\0').filter((line) => line.length > 0);

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      entries.push({
        additions: parts[0] === '-' ? null : parseInt(parts[0], 10),
        deletions: parts[1] === '-' ? null : parseInt(parts[1], 10),
        path: parts[2],
      });
    }
  }

  return entries;
}
