#!/usr/bin/env node

/**
 * JWT Secret Generator Script (Node.js version)
 * Generates secure random secrets for JWT authentication
 */

const crypto = require('crypto');
const fs = require('fs');
const readline = require('readline');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

// Helper functions for colored output
const print = {
  header: (text) => {
    console.log(`${colors.bold}${colors.blue}╔${'═'.repeat(78)}╗${colors.reset}`);
    console.log(`${colors.bold}${colors.blue}║${colors.reset}${text.padStart(45).padEnd(78)}${colors.bold}${colors.blue}║${colors.reset}`);
    console.log(`${colors.bold}${colors.blue}╚${'═'.repeat(78)}╝${colors.reset}\n`);
  },
  section: (text) => {
    console.log(`${colors.bold}${colors.cyan}${text}${colors.reset}`);
    console.log(`${colors.cyan}${'─'.repeat(80)}${colors.reset}`);
  },
  success: (text) => console.log(`${colors.green}✓${colors.reset} ${text}`),
  warning: (text) => console.log(`${colors.yellow}⚠${colors.reset} ${text}`),
  error: (text) => console.log(`${colors.red}✗${colors.reset} ${text}`),
  info: (text) => console.log(`${colors.blue}ℹ${colors.reset} ${text}`),
};

// Generate a secure random secret (32 bytes = 256 bits, base64)
function generateSecret() {
  return crypto.randomBytes(32).toString('base64');
}

// Generate a long random hex string (64 bytes = 512 bits, hex)
function generateStaticToken() {
  return crypto.randomBytes(64).toString('hex');
}

// Ask user a yes/no question
function askQuestion(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// Main function
async function main() {
  console.clear();
  print.header('JWT Secret Generator');

  // Generate secrets
  print.section('Generating Secure Secrets');
  console.log();

  const JWT_SECRET = generateSecret();
  const AGENT_JWT_SECRET = generateSecret();
  const AGENT_STATIC_TOKEN = generateStaticToken();

  print.success('Generated JWT_SECRET (for user authentication)');
  print.success('Generated AGENT_JWT_SECRET (for controller → agent communication)');
  print.success('Generated AGENT_STATIC_TOKEN (for agent → controller communication)');
  console.log();

  // Display secrets
  print.section('Generated Secrets');
  console.log();

  console.log(`${colors.bold}1. JWT_SECRET${colors.reset} (User Authentication - Frontend ↔ Controller)`);
  console.log(`   ${colors.green}${JWT_SECRET}${colors.reset}`);
  console.log();

  console.log(`${colors.bold}2. AGENT_JWT_SECRET${colors.reset} (Controller → Agent - Dynamic JWT tokens)`);
  console.log(`   ${colors.green}${AGENT_JWT_SECRET}${colors.reset}`);
  console.log();

  console.log(`${colors.bold}3. AGENT_STATIC_TOKEN${colors.reset} (Agent → Controller - Static token)`);
  console.log(`   ${colors.green}${AGENT_STATIC_TOKEN}${colors.reset}`);
  console.log();

  // Instructions
  print.section('Installation Instructions');
  console.log();

  console.log(`${colors.bold}${colors.yellow}STEP 1: Update Controller Backend${colors.reset}`);
  console.log(`File: ${colors.cyan}controller-backend/.env${colors.reset}`);
  console.log();
  console.log('Add or update these lines:');
  console.log(`${colors.green}JWT_SECRET=${JWT_SECRET}${colors.reset}`);
  console.log(`${colors.green}AGENT_JWT_SECRET=${AGENT_JWT_SECRET}${colors.reset}`);
  console.log(`${colors.green}AGENT_STATIC_TOKEN=${AGENT_STATIC_TOKEN}${colors.reset}`);
  console.log();

  console.log(`${colors.bold}${colors.yellow}STEP 2: Update Agent Backend${colors.reset}`);
  console.log(`File: ${colors.cyan}agent-backend/.env${colors.reset}`);
  console.log();
  console.log('Add or update these lines:');
  console.log(`${colors.green}AGENT_JWT_SECRET=${AGENT_JWT_SECRET}${colors.reset}`);
  console.log(`${colors.green}AGENT_JWT_TOKEN=${AGENT_STATIC_TOKEN}${colors.reset}`);
  console.log();

  print.warning('CRITICAL: AGENT_JWT_SECRET must be IDENTICAL in both files!');
  print.warning('CRITICAL: AGENT_STATIC_TOKEN (controller) = AGENT_JWT_TOKEN (agent)!');
  console.log();

  // Explanation
  print.section('How Authentication Works');
  console.log();

  console.log(`${colors.bold}Three Types of Authentication:${colors.reset}`);
  console.log();
  console.log(`1. ${colors.cyan}Frontend → Controller${colors.reset} (User Login)`);
  console.log('   - Uses JWT_SECRET');
  console.log('   - Dynamic tokens generated on login');
  console.log('   - Tokens expire after configured time');
  console.log();
  console.log(`2. ${colors.cyan}Controller → Agent${colors.reset} (Trigger Backups, etc.)`);
  console.log('   - Uses AGENT_JWT_SECRET');
  console.log('   - Dynamic tokens generated per request');
  console.log('   - Controller signs, Agent verifies');
  console.log();
  console.log(`3. ${colors.cyan}Agent → Controller${colors.reset} (Fetch Storage Pools, etc.)`);
  console.log('   - Uses AGENT_STATIC_TOKEN / AGENT_JWT_TOKEN');
  console.log('   - Static token (no expiration)');
  console.log('   - Simple string comparison');
  console.log();

  // Security notes
  print.section('Security Notes');
  console.log();

  print.info('JWT_SECRET: 256-bit base64 encoded (for user tokens)');
  print.info('AGENT_JWT_SECRET: 256-bit base64 encoded (for controller→agent JWT)');
  print.info('AGENT_STATIC_TOKEN: 512-bit hex encoded (for agent→controller static)');
  print.info('Never commit .env files to version control');
  print.info('Keep these secrets confidential');
  print.info('Restart both backends after updating .env files');
  console.log();

  // Quick copy commands
  print.section('Quick Update Commands');
  console.log();

  console.log(`${colors.bold}Backup existing .env files:${colors.reset}`);
  console.log(`${colors.cyan}cp controller-backend/.env controller-backend/.env.backup${colors.reset}`);
  console.log(`${colors.cyan}cp agent-backend/.env agent-backend/.env.backup${colors.reset}`);
  console.log();

  console.log(`${colors.bold}Edit .env files:${colors.reset}`);
  console.log(`${colors.cyan}nano controller-backend/.env${colors.reset}`);
  console.log(`${colors.cyan}nano agent-backend/.env${colors.reset}`);
  console.log('# OR');
  console.log(`${colors.cyan}code controller-backend/.env${colors.reset}`);
  console.log(`${colors.cyan}code agent-backend/.env${colors.reset}`);
  console.log();

  // Verification
  print.section('Verification Steps');
  console.log();

  console.log('1. Verify all secrets are set:');
  console.log(`   ${colors.cyan}grep -E 'JWT_SECRET|AGENT_JWT_SECRET|AGENT_STATIC_TOKEN' controller-backend/.env${colors.reset}`);
  console.log(`   ${colors.cyan}grep -E 'AGENT_JWT_SECRET|AGENT_JWT_TOKEN' agent-backend/.env${colors.reset}`);
  console.log();

  console.log('2. Verify AGENT_JWT_SECRET matches in both files:');
  console.log(`   ${colors.cyan}diff <(grep AGENT_JWT_SECRET controller-backend/.env) <(grep AGENT_JWT_SECRET agent-backend/.env)${colors.reset}`);
  console.log('   (No output means they match)');
  console.log();

  console.log('3. Verify static token matches:');
  console.log(`   ${colors.cyan}CONTROLLER_TOKEN=$(grep AGENT_STATIC_TOKEN controller-backend/.env | cut -d'=' -f2)${colors.reset}`);
  console.log(`   ${colors.cyan}AGENT_TOKEN=$(grep AGENT_JWT_TOKEN agent-backend/.env | cut -d'=' -f2)${colors.reset}`);
  console.log(`   ${colors.cyan}[ "$CONTROLLER_TOKEN" = "$AGENT_TOKEN" ] && echo "✓ Tokens match" || echo "✗ Tokens don't match"${colors.reset}`);
  console.log();

  console.log('4. Restart services:');
  console.log(`   ${colors.cyan}cd controller-backend && npm run dev${colors.reset}`);
  console.log(`   ${colors.cyan}cd agent-backend && npm run dev${colors.reset}`);
  console.log();

  // Save to file option
  print.section('Save Secrets to File?');
  console.log();

  const shouldSave = await askQuestion('Do you want to save these secrets to a file? (y/N): ');

  if (shouldSave) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `jwt-secrets-${timestamp}.txt`;

    const content = `JWT Secrets Generated on ${new Date().toLocaleString()}
${'='.repeat(80)}

CONTROLLER BACKEND (controller-backend/.env):
----------------------------------------------
JWT_SECRET=${JWT_SECRET}
AGENT_JWT_SECRET=${AGENT_JWT_SECRET}
AGENT_STATIC_TOKEN=${AGENT_STATIC_TOKEN}


AGENT BACKEND (agent-backend/.env):
------------------------------------
AGENT_JWT_SECRET=${AGENT_JWT_SECRET}
AGENT_JWT_TOKEN=${AGENT_STATIC_TOKEN}


AUTHENTICATION FLOW:
--------------------
1. Frontend → Controller (User Login)
   - Uses: JWT_SECRET
   - Type: Dynamic JWT tokens
   
2. Controller → Agent (Trigger Backups)
   - Uses: AGENT_JWT_SECRET
   - Type: Dynamic JWT tokens
   
3. Agent → Controller (Fetch Storage Pools)
   - Uses: AGENT_STATIC_TOKEN / AGENT_JWT_TOKEN
   - Type: Static token (simple string)


IMPORTANT NOTES:
----------------
1. AGENT_JWT_SECRET must be IDENTICAL in both controller and agent .env files
2. AGENT_STATIC_TOKEN (controller) must equal AGENT_JWT_TOKEN (agent)
3. Never commit this file or .env files to version control
4. Keep these secrets confidential
5. Restart both backends after updating .env files


VERIFICATION COMMANDS:
----------------------
# Check if all secrets are set
grep -E 'JWT_SECRET|AGENT_JWT_SECRET|AGENT_STATIC_TOKEN' controller-backend/.env
grep -E 'AGENT_JWT_SECRET|AGENT_JWT_TOKEN' agent-backend/.env

# Verify AGENT_JWT_SECRET matches
diff <(grep AGENT_JWT_SECRET controller-backend/.env) <(grep AGENT_JWT_SECRET agent-backend/.env)

# Verify static token matches
CONTROLLER_TOKEN=$(grep AGENT_STATIC_TOKEN controller-backend/.env | cut -d'=' -f2)
AGENT_TOKEN=$(grep AGENT_JWT_TOKEN agent-backend/.env | cut -d'=' -f2)
[ "$CONTROLLER_TOKEN" = "$AGENT_TOKEN" ] && echo "✓ Tokens match" || echo "✗ Tokens don't match"

# Restart services
cd controller-backend && npm run dev
cd agent-backend && npm run dev


SECURITY INFORMATION:
---------------------
- JWT_SECRET: 256-bit cryptographically secure (base64)
- AGENT_JWT_SECRET: 256-bit cryptographically secure (base64)
- AGENT_STATIC_TOKEN: 512-bit cryptographically secure (hex)
- Generated using Node.js crypto.randomBytes()
`;

    fs.writeFileSync(filename, content);
    console.log();
    print.success(`Secrets saved to: ${colors.green}${filename}${colors.reset}`);
    print.warning('Remember to delete this file after updating your .env files!');
    console.log();
    console.log(`To delete: ${colors.cyan}rm ${filename}${colors.reset}`);
    console.log();
  }

  // Final summary
  print.section('Summary');
  console.log();

  console.log(`${colors.bold}What to do next:${colors.reset}`);
  console.log('1. Copy JWT_SECRET to controller-backend/.env');
  console.log('2. Copy AGENT_JWT_SECRET to BOTH controller-backend/.env AND agent-backend/.env');
  console.log('3. Copy AGENT_STATIC_TOKEN to controller-backend/.env');
  console.log('4. Copy AGENT_STATIC_TOKEN value to AGENT_JWT_TOKEN in agent-backend/.env');
  console.log('5. Verify all secrets are set correctly');
  console.log('6. Restart both backend services');
  console.log('7. Test login and agent communication');
  console.log();

  print.success('Done! Your JWT secrets are ready to use.');
  console.log();
}

// Run the script
main().catch((error) => {
  console.error(`${colors.red}Error:${colors.reset}`, error.message);
  process.exit(1);
});
