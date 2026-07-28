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

/**
 * Strip terminal escape sequences from a string headed for a plain-text
 * surface — an error message on a job record, a notification body.
 *
 * Deliberately different from sanitizeLog above, which KEEPS colour codes
 * because the log viewer renders them. Here the codes must go entirely, or a
 * failure line scraped out of the script log surfaces in the UI and RocketChat
 * as "[0;31m✗ Backup FAILED[0m".
 *
 * Mirrors controller-backend/utils/stripAnsi.js — the two services deploy
 * separately and share no package, so keep them in step.
 */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;            // ESC [ … final  (colours, cursor, private modes)
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;      // ESC ] … BEL|ST (window titles)
const SIMPLE_ESC = /\x1b[@-Z\\-_]?/g;              // two-char escapes + stray ESC
const ORPHAN_COLOR = /\[[0-9]{1,3}(?:;[0-9]{1,3})*m/g; // "[0;31m" whose ESC was already lost
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;   // control chars except \t and \n

function stripAnsi(input, opts = {}) {
  if (typeof input !== 'string') return input;

  let out = input
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(SIMPLE_ESC, '')
    .replace(ORPHAN_COLOR, '')
    .replace(/\r/g, '')
    .replace(CONTROL, '');

  if (opts.singleLine) out = out.replace(/\s+/g, ' ');

  return out.trim();
}

module.exports = { sanitizeLog, stripAnsi };
