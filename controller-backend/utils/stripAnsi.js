/**
 * Strip terminal escape sequences from a string destined for a plain-text
 * surface (RocketChat notifications, stored job.error, etc.).
 *
 * Backup_Manager.sh colourises its output, and the agent scrapes a failure
 * line straight out of the log to use as the error message. That line still
 * carries its colour codes, so notifications rendered as:
 *
 *   Error: \x1b[0;31m✗ Backup FAILED after 6s\x1b[0m
 *
 * which RocketChat shows literally as "[0;31m✗ Backup FAILED after 6s[0m".
 *
 * NOTE: this is deliberately separate from utils/logSanitizer.js on the agent,
 * which KEEPS colour codes because the log viewer renders them. Here we want
 * the codes gone entirely.
 */

// Full CSI sequences: ESC [ params intermediates final. Covers colours (…m),
// cursor moves (…A/K), and private modes (…?25l).
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// OSC sequences (ESC ] … BEL or ESC \), e.g. window-title sets.
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// Two-character escapes (ESC = , ESC > , …) and any stray lone ESC.
const SIMPLE_ESC = /\x1b[@-Z\\-_]?/g;
// Colour codes whose ESC byte was already lost somewhere upstream, leaving a
// bare "[0;31m". Tight enough not to touch ordinary bracketed text.
const ORPHAN_COLOR = /\[[0-9]{1,3}(?:;[0-9]{1,3})*m/g;
// Remaining control characters (NUL, BEL, backspace, …) minus \t and \n.
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * @param {*} input     value to clean (non-strings are returned unchanged)
 * @param {object} [opts]
 * @param {boolean} [opts.singleLine=false] collapse all whitespace runs to one space
 * @returns {*} the cleaned string, or `input` untouched if it wasn't a string
 */
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

module.exports = { stripAnsi };
