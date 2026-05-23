# Contributing to KVM Backup Manager

First off, thank you for considering contributing to KVM Backup Manager! It's people like you that make this project better for everyone.

This project is maintained by **Mohammad Amin Hashemi** and welcomes contributions from the open-source community. Whether you're fixing bugs, adding features, improving documentation, or suggesting enhancements, your contributions are valued and appreciated.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Commit Message Guidelines](#commit-message-guidelines)
- [Contact](#contact)

## 📜 Code of Conduct

This project and everyone participating in it is governed by respect and professionalism. By participating, you are expected to uphold this standard. Please report unacceptable behavior to [aminhashemiwin10@gmail.com](mailto:aminhashemiwin10@gmail.com).

## 🤝 How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the existing issues to avoid duplicates. When you create a bug report, include as many details as possible:

- **Use a clear and descriptive title**
- **Describe the exact steps to reproduce the problem**
- **Provide specific examples** (code snippets, screenshots, logs)
- **Describe the behavior you observed** and what you expected
- **Include your environment details** (OS, Node.js version, etc.)

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion:

- **Use a clear and descriptive title**
- **Provide a detailed description** of the suggested enhancement
- **Explain why this enhancement would be useful**
- **List any alternative solutions** you've considered

### Your First Code Contribution

Unsure where to begin? Look for issues labeled:
- `good first issue` - Simple issues for newcomers
- `help wanted` - Issues that need attention
- `bug` - Bug fixes are always welcome
- `enhancement` - Feature improvements

### Pull Requests

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Test your changes thoroughly
5. Commit with clear messages
6. Push to your fork
7. Open a Pull Request

## 🛠 Development Setup

### Prerequisites

- Node.js 18.x or higher
- Python 3.9+ (for agent)
- Git

### Setup Steps

```bash
# Clone your fork
git clone https://github.com/YOUR-USERNAME/kvm-backup-manager.git
cd kvm-backup-manager

# Install controller dependencies
cd controller-backend
npm install
cp .env.example .env
# Edit .env with your settings

# Install agent dependencies
cd ../agent-backend
npm install
cp .env.example .env
# Edit .env with your settings

# Install frontend dependencies
cd ../frontend
npm install
cp .env.example .env
# Edit .env with your settings
```

### Running in Development Mode

```bash
# Terminal 1 - Controller Backend
cd controller-backend
npm run dev

# Terminal 2 - Agent Backend
cd agent-backend
npm run dev

# Terminal 3 - Frontend
cd frontend
npm install   # Install deps including framer-motion, cmdk, jspdf, papaparse
npm run dev
```

### Running Tests

```bash
# Run backend tests
cd controller-backend
npm test

# Run frontend tests
cd frontend
npm test
```

## 🔄 Pull Request Process

1. **Update Documentation**: Update README.md if you change functionality
2. **Follow Coding Standards**: Ensure your code follows the project's style
3. **Test Thoroughly**: Test your changes in different scenarios
4. **Update CHANGELOG**: Add your changes to CHANGELOG.md (if exists)
5. **One Feature Per PR**: Keep pull requests focused on a single feature/fix
6. **Describe Your Changes**: Provide a clear description of what and why

### PR Title Format

```
<type>: <short description>

Examples:
feat: Add backup encryption support
fix: Resolve stuck job recovery issue
docs: Update installation guide
refactor: Improve backup executor performance
test: Add tests for schedule validation
```

### PR Description Template

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
Describe how you tested your changes

## Screenshots (if applicable)
Add screenshots for UI changes

## Checklist
- [ ] My code follows the project's style guidelines
- [ ] I have tested my changes
- [ ] I have updated the documentation
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix/feature works
```

## 📝 Coding Standards

### JavaScript/Node.js

- Use **ES6+ syntax** (const/let, arrow functions, async/await)
- Use **camelCase** for variables and functions
- Use **PascalCase** for classes and React components
- Add **JSDoc comments** for complex functions
- Keep functions **small and focused** (single responsibility)
- Use **meaningful variable names**
- Handle errors properly with try/catch
- Avoid nested callbacks (use async/await)

### React/Frontend

- Use **functional components** with hooks
- Keep components **small and reusable**
- Use **TypeScript** for type safety
- Follow **React best practices** (keys, memo, etc.)
- Use **TanStack Query** for data fetching
- Keep **business logic separate** from UI components

### Bash Scripts

- Use **shellcheck** for linting
- Add **comments** for complex logic
- Use **proper error handling** (set -e, exit codes)
- Make scripts **idempotent** when possible
- Use **meaningful variable names**

### Code Style

```javascript
// Good
const getUserBackups = async (userId) => {
  try {
    const backups = await backupService.getByUser(userId);
    return backups.filter(backup => backup.status === 'completed');
  } catch (error) {
    logger.error('Failed to get user backups:', error);
    throw new Error('Unable to retrieve backups');
  }
};

// Bad
function get(id) {
  var data = service.get(id)
  return data.filter(function(d) { return d.s == 'completed' })
}
```

## 💬 Commit Message Guidelines

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- **feat**: New feature
- **fix**: Bug fix
- **docs**: Documentation changes
- **style**: Code style changes (formatting, no logic change)
- **refactor**: Code refactoring
- **perf**: Performance improvements
- **test**: Adding or updating tests
- **chore**: Maintenance tasks

### Examples

```
feat(backup): Add support for backup encryption

Implement AES-256 encryption for backup files with
configurable encryption keys per storage pool.

Closes #123

---

fix(restore): Resolve stuck job recovery on startup

Jobs stuck at 0% progress are now properly detected
and marked as failed during startup recovery.

Fixes #456

---

docs(readme): Update installation instructions

Add detailed steps for SSH key setup and storage
pool configuration.
```

## 🧪 Testing Guidelines

- Write tests for new features
- Update tests when modifying existing features
- Ensure all tests pass before submitting PR
- Test edge cases and error scenarios
- Test on different environments when possible

## 📚 Documentation

- Update README.md for user-facing changes
- Add JSDoc comments for complex functions
- Update API documentation for endpoint changes
- Include code examples in documentation
- Keep documentation clear and concise

## 🐛 Debugging Tips

### Backend Debugging

```bash
# Enable debug logging
NODE_ENV=development DEBUG=* npm run dev

# Check logs
tail -f controller-backend/data/logs/*.log
tail -f agent-backend/logs/*.log
```

### Frontend Debugging

- Use React DevTools
- Check browser console for errors
- Use Network tab for API calls
- Check WebSocket connection in Network tab

## 📞 Contact

- **Author**: Mohammad Amin Hashemi
- **Email**: [aminhashemiwin10@gmail.com](mailto:aminhashemiwin10@gmail.com)
- **LinkedIn**: [linkedin.com/in/amin-hashemi-2955061bb](https://www.linkedin.com/in/amin-hashemi-2955061bb)
- **GitHub**: [@aminhashemi1994](https://github.com/aminhashemi1994)
- **GitHub Issues**: For bug reports and feature requests
- **GitHub Discussions**: For questions and general discussion

## 🎉 Recognition

Contributors will be recognized in:
- README.md contributors section
- Release notes
- Project documentation

Thank you for contributing to KVM Backup Manager! 🚀
