/**
 * Refuse to start with missing or placeholder secrets.
 *
 * The services used to fall back to hardcoded defaults (published in the
 * repository) when a secret was unset, which let anyone forge tokens. Each
 * named variable must now be set, at least 32 characters long, and not one of
 * the example placeholders. Generate values with ./generate-jwt-secrets.sh.
 */
const PLACEHOLDER = /change-in-production|change-this|your-secret|use-openssl|use-long-random/i;
const MIN_LENGTH = 32;

function secretProblem(value) {
  if (!value) return 'is not set';
  if (value.length < MIN_LENGTH) return `must be at least ${MIN_LENGTH} characters`;
  if (PLACEHOLDER.test(value)) return 'still has the example placeholder value';
  return null;
}

/**
 * @param {string[]} required  variables that must be set
 * @param {string[]} optional  variables that are validated only when set
 */
function requireSecrets(required, optional = []) {
  const problems = [];
  for (const name of required) {
    const problem = secretProblem(process.env[name]);
    if (problem) problems.push(`${name} ${problem}`);
  }
  for (const name of optional) {
    if (process.env[name] === undefined || process.env[name] === '') continue;
    const problem = secretProblem(process.env[name]);
    if (problem) problems.push(`${name} ${problem}`);
  }
  if (problems.length) {
    console.error('✗ Refusing to start: insecure configuration in .env');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('  Generate secure values with ./generate-jwt-secrets.sh');
    process.exit(1);
  }
}

module.exports = { requireSecrets };
