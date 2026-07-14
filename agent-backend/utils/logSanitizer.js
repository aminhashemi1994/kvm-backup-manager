/**
 * Sanitize a raw job log for serving/display.
 *
 * Backup_Manager.sh / Restore_Manager.sh render in-place progress bars
 * (\r redraws, cursor-up/erase ANSI sequences), and tmux pipe-pane captures
 * every render into the log file. Served raw, that turns into thousands of
 * near-identical lines and walls of blank lines. This helper reduces the log
 * to what a terminal would actually display:
 *
 *  - strips cursor-movement/erase sequences (keeps color codes for viewers)
 *  - keeps only the final \r-segment of each physical line
 *  - drops consecutive duplicate lines
 *  - squeezes runs of blank lines down to one
 *  - optionally tails the last N lines to bound the payload size
 */
function sanitizeLog(content, tailLines = null) {
  if (!content) return '';

  let lines = content.split('\n').map(l => {
    // Cursor/erase CSI sequences (\033[5A, \033[K, ...) and private-mode
    // sequences (\033[?25l cursor-hide, ...) are meaningless outside a
    // terminal. Color codes (ending in 'm') are kept.
    const clean = l
      .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1b\[[0-9;]*[A-LST]/g, '');
    // A line ending in \r has its real content BEFORE that \r — strip
    // trailing \r first so the line doesn't collapse to an empty string.
    const trimmed = clean.replace(/\r+$/, '');
    const idx = trimmed.lastIndexOf('\r');
    return idx === -1 ? trimmed : trimmed.slice(idx + 1);
  });

  let blankRun = 0;
  lines = lines.filter((l, i) => {
    if (l.trim() === '') {
      blankRun++;
      return blankRun <= 1;
    }
    blankRun = 0;
    return i === 0 || l !== lines[i - 1];
  });

  const tail = Number(tailLines);
  if (Number.isFinite(tail) && tail > 0 && lines.length > tail) {
    const truncated = lines.length - tail;
    lines = [`... (${truncated} earlier lines omitted — use full log download to see everything) ...`, ...lines.slice(-tail)];
  }

  return lines.join('\n');
}

module.exports = { sanitizeLog };
