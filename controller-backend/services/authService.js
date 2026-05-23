const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs').promises;
const path = require('path');

const USERS_FILE = path.join(__dirname, '../data/users.json');
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';

/**
 * Ensure users file exists and has default admin user
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
        await fs.writeFile(USERS_FILE, JSON.stringify(usersData, null, 2));
        console.log('[Auth] Migrated users to RBAC schema');
      }
    }
    
    // If no users exist, create default admin
    if (!usersData.users || usersData.users.length === 0) {
      console.log('[Auth] No users found, creating default admin user...');
      const defaultPassword = await bcrypt.hash('admin123', 10);
      usersData.users = [
        {
          id: '1',
          username: 'admin',
          password: defaultPassword,
          role: 'admin',
          email: null,
          fullName: 'Administrator',
          disabled: false,
          accessGrants: { backupHostIds: [] }, // admin has implicit full access
          createdAt: new Date().toISOString()
        }
      ];
      await fs.writeFile(USERS_FILE, JSON.stringify(usersData, null, 2));
      console.log('[Auth] Default admin user created (username: admin, password: admin123)');
    }
  } catch (error) {
    // File doesn't exist, create it with default admin user
    console.log('[Auth] Users file not found, creating with default admin user...');
    const defaultPassword = await bcrypt.hash('admin123', 10);
    const defaultUsers = {
      users: [
        {
          id: '1',
          username: 'admin',
          password: defaultPassword,
          role: 'admin',
          email: null,
          fullName: 'Administrator',
          disabled: false,
          accessGrants: { backupHostIds: [] },
          createdAt: new Date().toISOString()
        }
      ]
    };
    
    await fs.writeFile(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
    console.log('[Auth] Default admin user created (username: admin, password: admin123)');
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
  await fs.writeFile(USERS_FILE, JSON.stringify(data, null, 2));
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
  const agentSecret = process.env.AGENT_JWT_SECRET || 'agent-secret-key-change-in-production';
  
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
  createUser,
  updateUser,
  deleteUser,
  listUsers,
  getUserById,
  grantAccess,
  revokeAccess,
  VALID_ROLES,
};
