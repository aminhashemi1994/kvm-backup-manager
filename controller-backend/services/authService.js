const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { writeJSON, mutateJSON } = require('./fileStorage');

const USERS_FILE = path.join(__dirname, '../data/users.json');
// One-time token that must be presented to create the initial admin, so the
// first person to reach the login page can't claim the instance. It is printed
// to the controller log and stored (mode 0600) next to users.json.
const SETUP_TOKEN_FILE = path.join(__dirname, '../data/setup-token');
const JWT_SECRET = process.env.JWT_SECRET; // validated at startup (utils/requireSecrets.js)
// User session tokens use a short, sliding expiry. Each authenticated request
// mints a fresh token (see middleware/auth.js), so an active session keeps
// extending. After ~30 minutes of inactivity the token expires and the
// frontend auto-logs-out. This ONLY affects frontend↔controller user tokens;
// agent tokens (static + agent JWT) are separate and unaffected.
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30m';

/**
 * Ensure users file exists (no default user is created)
 */
async function ensureUsersFile() {
  try {
    // Check if file exists
    await fs.access(USERS_FILE);
    
    // File exists, check if it has users
    const data = await fs.readFile(USERS_FILE, 'utf8');
    const usersData = JSON.parse(data);
    
    // Migrate existing users to new schema (Item 9)
    let migrated = false;
    if (usersData.users && Array.isArray(usersData.users)) {
      for (const user of usersData.users) {
        // Ensure role
        if (!user.role) {
          user.role = 'admin';
          migrated = true;
        }
        // Add accessGrants if missing (admin gets * implicitly, others get [])
        if (!user.accessGrants) {
          user.accessGrants = { backupHostIds: [] };
          migrated = true;
        }
        // Add metadata fields
        if (!user.email) user.email = null;
        if (!user.fullName) user.fullName = null;
        if (user.disabled === undefined) user.disabled = false;
      }
      if (migrated) {
        await writeJSON(USERS_FILE, usersData);
        console.log('[Auth] Migrated users to RBAC schema');
      }
    }
    
    // No users yet: leave the list empty. The first admin is created through
    // the setup flow on the login page (see setupInitialAdmin).
    if (!usersData.users) {
      usersData.users = [];
      await writeJSON(USERS_FILE, usersData);
    }
  } catch (error) {
    // Never reset an existing (e.g. corrupted) file: that would reopen setup
    if (error.code !== 'ENOENT') throw error;
    // File doesn't exist: create it empty and wait for initial setup
    console.log('[Auth] Users file not found, waiting for initial admin setup...');
    await writeJSON(USERS_FILE, { users: [] });
  }
}

/**
 * Read users from file
 */
async function readUsers() {
  await ensureUsersFile();
  const data = await fs.readFile(USERS_FILE, 'utf8');
  return JSON.parse(data);
}

/**
 * Write users to file
 */
async function writeUsers(data) {
  await writeJSON(USERS_FILE, data);
}

/**
 * Authenticate user and generate JWT token
 */
async function login(username, password) {
  const usersData = await readUsers();
  const user = usersData.users.find(u => u.username === username);
  
  if (!user) {
    return { success: false, error: 'Invalid username or password' };
  }
  
  const isValidPassword = await bcrypt.compare(password, user.password);
  
  if (!isValidPassword) {
    return { success: false, error: 'Invalid username or password' };
  }

  // Item 8: Reject disabled users
  if (user.disabled) {
    return { success: false, error: 'Account is disabled. Contact an administrator.' };
  }
  
  // Generate JWT token
  const token = jwt.sign(
    { 
      id: user.id, 
      username: user.username, 
      role: user.role,
      accessGrants: user.accessGrants || { backupHostIds: [] },
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
  
  return {
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      accessGrants: user.accessGrants || { backupHostIds: [] },
    }
  };
}

/**
 * True when no user exists yet and the initial admin must be created
 */
async function needsSetup() {
  const usersData = await readUsers();
  return usersData.users.length === 0;
}

function validateAdminCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return 'Username and password are required';
  }
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return 'Username must be 3-32 characters (letters, numbers, . _ -)';
  }
  if (password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  // bcrypt silently ignores everything past 72 bytes
  if (Buffer.byteLength(password, 'utf8') > 72) {
    return 'Password must be at most 72 bytes';
  }
  return null;
}

/**
 * Atomically create the first admin. Returns false if a user already exists.
 */
async function createInitialAdmin(username, password) {
  const hashed = await bcrypt.hash(password, 10);
  const { written } = await mutateJSON(USERS_FILE, (data) => {
    if (!Array.isArray(data.users)) data.users = [];
    if (data.users.length > 0) return false;
    data.users.push({
      id: '1',
      username,
      password: hashed,
      role: 'admin',
      email: null,
      fullName: 'Administrator',
      disabled: false,
      accessGrants: { backupHostIds: [] }, // admin has implicit full access
      createdAt: new Date().toISOString()
    });
  });
  if (written) {
    await fs.rm(SETUP_TOKEN_FILE, { force: true });
    console.log(`[Auth] Initial admin user "${username}" created`);
  }
  return written;
}

/**
 * Called at startup. If no user exists, either bootstrap the admin from
 * INITIAL_ADMIN_USERNAME / INITIAL_ADMIN_PASSWORD, or make sure a setup token
 * exists and print it so the operator can finish setup in the web UI.
 */
async function prepareInitialSetup() {
  await ensureUsersFile();
  if (!(await needsSetup())) {
    await fs.rm(SETUP_TOKEN_FILE, { force: true });
    return;
  }

  const envUser = process.env.INITIAL_ADMIN_USERNAME;
  const envPass = process.env.INITIAL_ADMIN_PASSWORD;
  if (envUser && envPass) {
    const invalid = validateAdminCredentials(envUser, envPass);
    if (invalid) throw new Error(`[Auth] INITIAL_ADMIN_* rejected: ${invalid}`);
    await createInitialAdmin(envUser, envPass);
    return;
  }

  let token;
  try {
    token = (await fs.readFile(SETUP_TOKEN_FILE, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    await fs.writeFile(SETUP_TOKEN_FILE, token + '\n', { mode: 0o600 });
  }
  console.log('='.repeat(72));
  console.log('[Auth] No users exist. Open the web UI to create the administrator.');
  console.log(`[Auth] Setup token: ${token}`);
  console.log(`[Auth] (also stored in ${SETUP_TOKEN_FILE})`);
  console.log('='.repeat(72));
}

async function checkSetupToken(provided) {
  let expected;
  try {
    expected = (await fs.readFile(SETUP_TOKEN_FILE, 'utf8')).trim();
  } catch (error) {
    return false;
  }
  if (!expected || typeof provided !== 'string') return false;
  const a = crypto.createHash('sha256').update(provided.trim()).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Create the first admin account from the web UI. Only allowed while no users
 * exist and with the setup token printed at startup.
 */
async function setupInitialAdmin(username, password, setupToken) {
  if (!(await needsSetup())) {
    return { success: false, error: 'Initial setup has already been completed', code: 'SETUP_DONE' };
  }
  if (!(await checkSetupToken(setupToken))) {
    return { success: false, error: 'Invalid setup token', code: 'BAD_TOKEN' };
  }
  const invalid = validateAdminCredentials(username, password);
  if (invalid) return { success: false, error: invalid };

  if (!(await createInitialAdmin(username, password))) {
    return { success: false, error: 'Initial setup has already been completed', code: 'SETUP_DONE' };
  }
  return login(username, password);
}

/**
 * Change user password
 */
async function changePassword(username, currentPassword, newPassword) {
  const usersData = await readUsers();
  const user = usersData.users.find(u => u.username === username);
  
  if (!user) {
    return { success: false, error: 'User not found' };
  }
  
  const isValidPassword = await bcrypt.compare(currentPassword, user.password);
  
  if (!isValidPassword) {
    return { success: false, error: 'Current password is incorrect' };
  }
  
  if (newPassword.length < 6) {
    return { success: false, error: 'New password must be at least 6 characters' };
  }
  
  // Hash new password
  user.password = await bcrypt.hash(newPassword, 10);
  user.passwordChangedAt = new Date().toISOString();
  
  await writeUsers(usersData);
  
  return { success: true, message: 'Password changed successfully' };
}

/**
 * Verify JWT token
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

/**
 * Generate agent JWT token (for controller -> agent communication)
 */
function generateAgentToken(agentId, agentName) {
  const agentSecret = process.env.AGENT_JWT_SECRET;
  
  return jwt.sign(
    { 
      agentId, 
      agentName,
      type: 'agent'
    },
    agentSecret,
    { expiresIn: '7d' } // Agents get longer-lived tokens
  );
}

// ─── Item 9: User management ────────────────────────────────────────────────

const VALID_ROLES = ['admin', 'user', 'viewer'];

/**
 * Create a new user (admin only)
 */
async function createUser({ username, password, role, email, fullName, accessGrants }) {
  if (!username || !password) {
    return { success: false, error: 'Username and password are required' };
  }
  if (!VALID_ROLES.includes(role)) {
    return { success: false, error: `Role must be one of: ${VALID_ROLES.join(', ')}` };
  }
  if (password.length < 6) {
    return { success: false, error: 'Password must be at least 6 characters' };
  }

  const usersData = await readUsers();
  if (usersData.users.find(u => u.username === username)) {
    return { success: false, error: 'Username already exists' };
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const newUser = {
    id: require('uuid').v4(),
    username,
    password: hashedPassword,
    role,
    email: email || null,
    fullName: fullName || null,
    disabled: false,
    accessGrants: accessGrants || { backupHostIds: [] },
    createdAt: new Date().toISOString(),
  };

  usersData.users.push(newUser);
  await writeUsers(usersData);

  const { password: _, ...safeUser } = newUser;
  return { success: true, data: safeUser };
}

/**
 * Update a user (admin only)
 */
async function updateUser(userId, updates) {
  const usersData = await readUsers();
  const user = usersData.users.find(u => u.id === userId);
  if (!user) return { success: false, error: 'User not found' };

  if (updates.role && !VALID_ROLES.includes(updates.role)) {
    return { success: false, error: `Role must be one of: ${VALID_ROLES.join(', ')}` };
  }
  if (updates.password) {
    if (updates.password.length < 6) {
      return { success: false, error: 'Password must be at least 6 characters' };
    }
    user.password = await bcrypt.hash(updates.password, 10);
  }
  if (updates.role !== undefined) user.role = updates.role;
  if (updates.email !== undefined) user.email = updates.email;
  if (updates.fullName !== undefined) user.fullName = updates.fullName;
  if (updates.disabled !== undefined) user.disabled = updates.disabled;
  if (updates.accessGrants !== undefined) user.accessGrants = updates.accessGrants;
  user.updatedAt = new Date().toISOString();

  await writeUsers(usersData);
  const { password: _, ...safeUser } = user;
  return { success: true, data: safeUser };
}

/**
 * Delete a user (admin only, cannot delete self)
 */
async function deleteUser(userId, requestingUserId) {
  if (userId === requestingUserId) {
    return { success: false, error: 'Cannot delete your own account' };
  }
  const usersData = await readUsers();
  const idx = usersData.users.findIndex(u => u.id === userId);
  if (idx === -1) return { success: false, error: 'User not found' };

  usersData.users.splice(idx, 1);
  await writeUsers(usersData);
  return { success: true };
}

/**
 * List all users (without passwords)
 */
async function listUsers() {
  const usersData = await readUsers();
  return usersData.users.map(({ password, ...u }) => u);
}

/**
 * Get a single user by ID (without password)
 */
async function getUserById(userId) {
  const usersData = await readUsers();
  const user = usersData.users.find(u => u.id === userId);
  if (!user) return null;
  const { password, ...safeUser } = user;
  return safeUser;
}

/**
 * Grant access to backup host(s) for a user
 */
async function grantAccess(userId, backupHostIds) {
  const usersData = await readUsers();
  const user = usersData.users.find(u => u.id === userId);
  if (!user) return { success: false, error: 'User not found' };

  if (!user.accessGrants) user.accessGrants = { backupHostIds: [] };
  const existing = new Set(user.accessGrants.backupHostIds);
  for (const id of backupHostIds) existing.add(id);
  user.accessGrants.backupHostIds = Array.from(existing);
  user.updatedAt = new Date().toISOString();

  await writeUsers(usersData);
  return { success: true, data: user.accessGrants };
}

/**
 * Revoke access to backup host(s) for a user
 */
async function revokeAccess(userId, backupHostIds) {
  const usersData = await readUsers();
  const user = usersData.users.find(u => u.id === userId);
  if (!user) return { success: false, error: 'User not found' };

  if (!user.accessGrants) user.accessGrants = { backupHostIds: [] };
  const toRemove = new Set(backupHostIds);
  user.accessGrants.backupHostIds = user.accessGrants.backupHostIds.filter(id => !toRemove.has(id));
  user.updatedAt = new Date().toISOString();

  await writeUsers(usersData);
  return { success: true, data: user.accessGrants };
}

module.exports = {
  login,
  changePassword,
  verifyToken,
  generateAgentToken,
  ensureUsersFile,
  needsSetup,
  prepareInitialSetup,
  setupInitialAdmin,
  createUser,
  updateUser,
  deleteUser,
  listUsers,
  getUserById,
  grantAccess,
  revokeAccess,
  VALID_ROLES,
};
